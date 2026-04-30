import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { MemoryStore } from "../memory.js";

// ============================================================================
// MEMORY SYSTEM
// ============================================================================

const SECTION_SPLIT = /(?=^## )/m;
const markerOf = (section: string) => `## ${section}`;
const bodyOf = (block: string) => block.slice(block.indexOf("\n") + 1);

export class Memory implements MemoryStore {
  private memoryDir: string;
  private plansDir: string;

  constructor(dataDir: string) {
    this.memoryDir = join(dataDir, "memory");
    this.plansDir = join(dataDir, "plans");
    mkdirSync(this.memoryDir, { recursive: true });
    mkdirSync(this.plansDir, { recursive: true });
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
      writeFileSync(path, newBlock, "utf-8");
      return;
    }

    const parts = existing.split(SECTION_SPLIT);
    const idx = parts.findIndex((p) => p.startsWith(marker + "\n"));

    if (idx >= 0) {
      parts[idx] = newBlock;
      writeFileSync(path, parts.join(""), "utf-8");
    } else {
      // Append at end (preserves legacy content not covered by any known section)
      writeFileSync(path, existing.trimEnd() + "\n\n" + newBlock, "utf-8");
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

  renameSection(from: string, to: string): "renamed" | "noop" | "merged" {
    const path = join(this.memoryDir, "MEMORY.md");
    const content = this.readMemory();
    if (!content) return "noop";

    const fromMarker = markerOf(from);
    const toMarker = markerOf(to);
    const parts = content.split(SECTION_SPLIT);
    const fromIdx = parts.findIndex((p) => p.startsWith(fromMarker + "\n"));
    if (fromIdx < 0) return "noop";

    const toIdx = parts.findIndex((p) => p.startsWith(toMarker + "\n"));

    if (toIdx >= 0) {
      parts[toIdx] = `${toMarker}\n${bodyOf(parts[toIdx])}\n${bodyOf(parts[fromIdx])}`;
      parts.splice(fromIdx, 1);
      writeFileSync(path, parts.join(""), "utf-8");
      return "merged";
    }

    parts[fromIdx] = `${toMarker}\n${bodyOf(parts[fromIdx])}`;
    writeFileSync(path, parts.join(""), "utf-8");
    return "renamed";
  }

  /** @deprecated Use writeSection instead */
  appendMemory(entry: string): void {
    const path = join(this.memoryDir, "MEMORY.md");
    const existing = this.readMemory();
    const updated = existing ? `${existing}\n${entry}` : entry;
    writeFileSync(path, updated, "utf-8");
  }

  // ── Daily notes ────────────────────────────────────────────────────────

  readDailyNotes(date?: string): string {
    const d = date ?? todayString();
    const path = join(this.memoryDir, `${d}.md`);
    if (!existsSync(path)) return "";
    return readFileSync(path, "utf-8");
  }

  appendDailyNote(note: string, date?: string): void {
    const d = date ?? todayString();
    const path = join(this.memoryDir, `${d}.md`);
    const existing = this.readDailyNotes(d);
    const updated = existing ? `${existing}\n${note}` : note;
    writeFileSync(path, updated, "utf-8");
  }

  // ── Plans ──────────────────────────────────────────────────────────────

  savePlan(plan: unknown): void {
    const path = join(this.plansDir, "current-plan.json");
    writeFileSync(path, JSON.stringify(plan, null, 2), "utf-8");
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

function todayString(): string {
  return new Date().toISOString().split("T")[0];
}
