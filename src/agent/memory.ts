import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

// ============================================================================
// MEMORY SYSTEM
// ============================================================================

export class Memory {
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
    return readFileSync(path, "utf-8");
  }

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
