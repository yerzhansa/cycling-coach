import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { MemoryStore, MemoryWriteSource } from "../memory.js";
import { todayInTZ } from "../agent/user-time.js";
import { atomicWriteFileSync } from "../io/atomic-write-file-sync.js";
import { safeReadJson } from "../io/safe-read-json.js";
import { eachDateKeyInRange } from "../io/date-keys.js";
import { appendJournalEntry } from "./journal.js";
import { appendLedgerEvent, LEDGER_FILENAME, type LedgerEventInput } from "./event-ledger.js";

// ============================================================================
// MEMORY SYSTEM
// ============================================================================

const SECTION_SPLIT = /(?=^## )/m;
const markerOf = (section: string) => `## ${section}`;
const bodyOf = (block: string) => block.slice(block.indexOf("\n") + 1);

const UPDATED_STAMP_PREFIX = "_updated: ";

export const SECTION_SOFT_WARN_CHARS = 4000;

// Loose passthrough: any JSON object passes with all keys intact; any non-object
// top level fails → null. Mirrors the plan_save tool's input schema so anything
// the tool can save, loadPlan accepts. A typed schema would null the entire plan
// when one hand-edited field is mistyped; the per-field guards in getContext
// handle mistypes gracefully instead.
const PlanFileSchema = z.record(z.string(), z.unknown());

// Embedded H2 lines would match SECTION_SPLIT and fragment the file into
// phantom sections; demote them one level so section CONTENT can no longer
// create section boundaries. (Section NAMES are a separate surface: markerOf
// interpolates the name unsanitized, but both tool paths constrain it via
// z.enum — out of scope here, which covers content-borne fragmentation only.)
function demoteEmbeddedH2(content: string): string {
  return content.replace(/^## /gm, "### ");
}

/**
 * Stamp a section body's first line with its write date. Idempotent: an
 * existing leading stamp (e.g. echoed back by the LLM from memory_read)
 * is replaced, never stacked — a body carries at most one leading stamp.
 */
function stampUpdated(content: string, date: string): string {
  let body = content;
  if (body.startsWith(UPDATED_STAMP_PREFIX)) {
    const nl = body.indexOf("\n");
    body = nl === -1 ? "" : body.slice(nl + 1);
  }
  return body === ""
    ? `${UPDATED_STAMP_PREFIX}${date}`
    : `${UPDATED_STAMP_PREFIX}${date}\n${body}`;
}

type RenameOutcome = "renamed" | "noop" | "merged";

/**
 * Apply a single section rename to `parts` IN PLACE. Shared between
 * `renameSection` (one rename + write) and `renameSections` (chain of
 * renames + single write); the in-place contract lets `renameSections`
 * chain without copying the array between iterations.
 */
function applyRename(parts: string[], from: string, to: string): RenameOutcome {
  const fromMarker = markerOf(from);
  const toMarker = markerOf(to);
  const fromIdx = parts.findIndex((p) => p.startsWith(fromMarker + "\n"));
  if (fromIdx < 0) return "noop";

  const toIdx = parts.findIndex((p) => p.startsWith(toMarker + "\n"));

  if (toIdx >= 0) {
    parts[toIdx] = `${toMarker}\n${bodyOf(parts[toIdx])}\n${bodyOf(parts[fromIdx])}`;
    parts.splice(fromIdx, 1);
    return "merged";
  }

  parts[fromIdx] = `${toMarker}\n${bodyOf(parts[fromIdx])}`;
  return "renamed";
}

export class Memory implements MemoryStore {
  private memoryDir: string;
  private plansDir: string;
  private tz: string;

  constructor(dataDir: string, tz: string = "UTC") {
    this.memoryDir = join(dataDir, "memory");
    this.plansDir = join(dataDir, "plans");
    this.tz = tz;
    mkdirSync(this.memoryDir, { recursive: true, mode: 0o700 });
    mkdirSync(this.plansDir, { recursive: true, mode: 0o700 });
  }

  // ── Long-term memory ──────────────────────────────────────────────────

  readMemory(): string {
    const path = join(this.memoryDir, "MEMORY.md");
    if (!existsSync(path)) return "";
    // Normalize CRLF → LF so section parsing works for files authored on
    // Windows or pasted from sources like Word/Notion. The marker check
    // `parts[idx].startsWith(marker + "\n")` would otherwise miss CRLF
    // headers and silently no-op every rename / read.
    return readFileSync(path, "utf-8").replace(/\r\n/g, "\n");
  }

  writeSection(section: string, content: string, source: MemoryWriteSource = "unattributed"): void {
    const path = join(this.memoryDir, "MEMORY.md");
    const existing = this.readMemory();
    const marker = markerOf(section);
    const stamped = stampUpdated(demoteEmbeddedH2(content), todayInTZ(this.tz));
    const newBlock = `${marker}\n${stamped}\n`;

    if (stamped.length > SECTION_SOFT_WARN_CHARS) {
      console.warn(
        `memory: section "${section}" is ${stamped.length} chars (soft cap ${SECTION_SOFT_WARN_CHARS}) — consider splitting or pruning`,
      );
    }

    appendJournalEntry(this.memoryDir, {
      ts: new Date().toISOString(),
      op: "write-section",
      section,
      oldBody: this.readSection(section),
      newBody: stamped,
      source,
    });

    if (!existing) {
      atomicWriteFileSync(path, newBlock);
      return;
    }

    const parts = existing.split(SECTION_SPLIT);
    const idx = parts.findIndex((p) => p.startsWith(marker + "\n"));

    if (idx >= 0) {
      parts[idx] = newBlock;
      atomicWriteFileSync(path, parts.join(""));
    } else {
      // Append at end (preserves legacy content not covered by any known section)
      atomicWriteFileSync(path, existing.trimEnd() + "\n\n" + newBlock);
    }
  }

  readSection(section: string): string | null {
    const content = this.readMemory();
    if (!content) return null;
    const marker = markerOf(section);
    const parts = content.split(SECTION_SPLIT);
    const block = parts.find((p) => p.startsWith(marker + "\n"));
    if (!block) return null;
    const body = bodyOf(block);
    return body.endsWith("\n") ? body.slice(0, -1) : body;
  }

  renameSection(from: string, to: string, source: MemoryWriteSource = "unattributed"): RenameOutcome {
    const path = join(this.memoryDir, "MEMORY.md");
    const content = this.readMemory();
    if (!content) return "noop";

    const parts = content.split(SECTION_SPLIT);
    const outcome = applyRename(parts, from, to);
    if (outcome === "noop") return outcome;

    const updated = parts.join("");
    appendJournalEntry(this.memoryDir, {
      ts: new Date().toISOString(),
      op: "rename-sections",
      section: null,
      oldBody: content,
      newBody: updated,
      source,
    });
    atomicWriteFileSync(path, updated);
    return outcome;
  }

  /**
   * Apply multiple section renames as a single read + single atomic write.
   * Used by the cycling-coach legacy migration so a partial migration cannot
   * be observed by Reference initialization. Returns the per-rename outcomes
   * in the same order as `renames`.
   */
  renameSections(
    renames: ReadonlyArray<readonly [string, string]>,
    source: MemoryWriteSource = "unattributed",
  ): RenameOutcome[] {
    const path = join(this.memoryDir, "MEMORY.md");
    const content = this.readMemory();
    if (!content) return renames.map(() => "noop" as const);

    const parts = content.split(SECTION_SPLIT);
    const outcomes: RenameOutcome[] = [];
    let mutated = false;
    for (const [from, to] of renames) {
      const outcome = applyRename(parts, from, to);
      outcomes.push(outcome);
      if (outcome !== "noop") mutated = true;
    }

    if (mutated) {
      const updated = parts.join("");
      appendJournalEntry(this.memoryDir, {
        ts: new Date().toISOString(),
        op: "rename-sections",
        section: null,
        oldBody: content,
        newBody: updated,
        source,
      });
      atomicWriteFileSync(path, updated);
    }
    return outcomes;
  }

  // ── Daily notes ────────────────────────────────────────────────────────

  readDailyNotes(date?: string): string {
    const d = date ?? todayInTZ(this.tz);
    const path = join(this.memoryDir, `${d}.md`);
    if (!existsSync(path)) return "";
    return readFileSync(path, "utf-8");
  }

  appendDailyNote(note: string, date?: string): void {
    const d = date ?? todayInTZ(this.tz);
    const path = join(this.memoryDir, `${d}.md`);
    const existing = this.readDailyNotes(d);
    if (existing && `\n${existing}\n`.includes(`\n${note}\n`)) {
      console.warn(
        JSON.stringify({ event: "daily_note_duplicate_skipped", date: d, noteChars: note.length }),
      );
      return;
    }
    const updated = existing ? `${existing}\n${note}` : note;
    atomicWriteFileSync(path, updated);
  }

  readDailyNotesInRange(from: string, to: string): Array<{ date: string; text: string }> {
    const out: Array<{ date: string; text: string }> = [];
    for (const date of eachDateKeyInRange(from, to)) {
      const text = this.readDailyNotes(date);
      if (text) out.push({ date, text });
    }
    return out;
  }

  readEventsRaw(): string {
    const path = join(this.memoryDir, LEDGER_FILENAME);
    if (!existsSync(path)) return "";
    return readFileSync(path, "utf-8");
  }

  appendEvent(event: LedgerEventInput): void {
    appendLedgerEvent(this.memoryDir, event);
  }

  // ── Plans ──────────────────────────────────────────────────────────────

  savePlan(plan: unknown, source: MemoryWriteSource = "unattributed"): void {
    const path = join(this.plansDir, "current-plan.json");
    const newBody = JSON.stringify(plan, null, 2);
    appendJournalEntry(this.memoryDir, {
      ts: new Date().toISOString(),
      op: "save-plan",
      section: null,
      oldBody: existsSync(path) ? readFileSync(path, "utf-8") : null,
      newBody,
      source,
    });
    atomicWriteFileSync(path, newBody);
  }

  loadPlan(): unknown | null {
    return safeReadJson<Record<string, unknown>>(
      join(this.plansDir, "current-plan.json"),
      PlanFileSchema,
    );
  }

  // ── Full context for system prompt ─────────────────────────────────────

  reload(): void {
    // No-op — Memory reads from disk on every access.
    // Explicit sync point for post-compaction and future caching.
  }

  getContext(): string {
    const parts: string[] = [];

    const memory = this.readMemory();
    if (memory) {
      parts.push("## Athlete Memory\n" + memory);
    }

    const daily = this.readDailyNotes();
    if (daily) {
      parts.push("## Today's Notes\n" + daily);
    }

    const plan = this.loadPlan();
    if (plan !== null && typeof plan === "object") {
      const p = plan as Record<string, unknown>;
      const lines: string[] = [];
      if (typeof p.name === "string") lines.push(`- Name: ${p.name}`);
      if (typeof p.primaryGoal === "string") lines.push(`- Goal: ${p.primaryGoal}`);
      if (typeof p.totalWeeks === "number" && Number.isFinite(p.totalWeeks)) {
        lines.push(`- Duration: ${p.totalWeeks} weeks`);
      }
      if (typeof p.status === "string") lines.push(`- Status: ${p.status}`);
      if (lines.length > 0) parts.push("## Current Plan\n" + lines.join("\n"));
    }

    return parts.join("\n\n");
  }
}
