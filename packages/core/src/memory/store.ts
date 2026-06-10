import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { MemoryStore } from "../memory.js";
import { todayInTZ } from "../agent/user-time.js";
import { atomicWriteFileSync } from "../io/atomic-write-file-sync.js";

// ============================================================================
// MEMORY SYSTEM
// ============================================================================

const SECTION_SPLIT = /(?=^## )/m;
const markerOf = (section: string) => `## ${section}`;
const bodyOf = (block: string) => block.slice(block.indexOf("\n") + 1);

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

  writeSection(section: string, content: string): void {
    const path = join(this.memoryDir, "MEMORY.md");
    const existing = this.readMemory();
    const marker = markerOf(section);
    const newBlock = `${marker}\n${content}\n`;

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

  renameSection(from: string, to: string): RenameOutcome {
    const path = join(this.memoryDir, "MEMORY.md");
    const content = this.readMemory();
    if (!content) return "noop";

    const parts = content.split(SECTION_SPLIT);
    const outcome = applyRename(parts, from, to);
    if (outcome === "noop") return outcome;

    atomicWriteFileSync(path, parts.join(""));
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

    if (mutated) atomicWriteFileSync(path, parts.join(""));
    return outcomes;
  }

  /** @deprecated Use writeSection instead */
  appendMemory(entry: string): void {
    const path = join(this.memoryDir, "MEMORY.md");
    const existing = this.readMemory();
    const updated = existing ? `${existing}\n${entry}` : entry;
    atomicWriteFileSync(path, updated);
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
    const updated = existing ? `${existing}\n${note}` : note;
    atomicWriteFileSync(path, updated);
  }

  // ── Plans ──────────────────────────────────────────────────────────────

  savePlan(plan: unknown): void {
    const path = join(this.plansDir, "current-plan.json");
    atomicWriteFileSync(path, JSON.stringify(plan, null, 2));
  }

  loadPlan(): unknown | null {
    const path = join(this.plansDir, "current-plan.json");
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf-8"));
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
    if (plan) {
      const p = plan as {
        name?: string;
        primaryGoal?: string;
        totalWeeks?: number;
        status?: string;
      };
      parts.push(
        `## Current Plan\n- Name: ${p.name}\n- Goal: ${p.primaryGoal}\n- Duration: ${p.totalWeeks} weeks\n- Status: ${p.status}`,
      );
    }

    return parts.join("\n\n");
  }
}
