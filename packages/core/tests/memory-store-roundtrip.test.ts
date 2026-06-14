import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Memory } from "../src/memory/store.js";

const STAMP = "_updated: 2026-06-11";

describe("Memory store round-trip", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "cc-storeroundtrip-"));
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-11T08:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("round-trips a single section with the _updated stamp", () => {
    const m = new Memory(dataDir);
    m.writeSection("Goals", "FTP 280W by August");
    expect(m.readSection("Goals")).toBe(`${STAMP}\nFTP 280W by August`);
  });

  it("round-trips N sections written in a deterministic non-sorted order", () => {
    const m = new Memory(dataDir);
    const names = ["Profile", "Health", "Goals", "Equipment", "Schedule", "Notes"];
    const order = [3, 0, 5, 1, 4, 2];
    for (const i of order) m.writeSection(names[i], `body-${names[i]}`);
    for (const name of names) {
      const back = m.readSection(name);
      expect(back?.replace(/\n$/, "")).toBe(`${STAMP}\nbody-${name}`);
    }
    expect(m.readSection("Goals")).toBe(`${STAMP}\nbody-Goals`);
    expect(m.readSection("Profile")).toBe(`${STAMP}\nbody-Profile\n`);
  });

  it("writes every section header exactly once across the multi-write", () => {
    const m = new Memory(dataDir);
    const names = ["Profile", "Health", "Goals", "Equipment", "Schedule", "Notes"];
    const order = [3, 0, 5, 1, 4, 2];
    for (const i of order) m.writeSection(names[i], `body-${names[i]}`);
    const file = readFileSync(join(dataDir, "memory", "MEMORY.md"), "utf-8");
    expect(file).toContain("## Profile\n");
    expect(file).toContain("## Notes\n");
    expect((file.match(/^## /gm) ?? []).length).toBe(6);
  });

  it("replaces a section body in place rather than appending a duplicate", () => {
    const m = new Memory(dataDir);
    m.writeSection("Goals", "first");
    m.writeSection("Goals", "second");
    expect(m.readSection("Goals")).toBe(`${STAMP}\nsecond`);
    const file = readFileSync(join(dataDir, "memory", "MEMORY.md"), "utf-8");
    expect((file.match(/^## Goals/gm) ?? []).length).toBe(1);
  });

  it("preserves legacy content not covered by any known section", () => {
    const m = new Memory(dataDir);
    writeFileSync(
      join(dataDir, "memory", "MEMORY.md"),
      "legacy free text line\n\n## Existing\nbody\n",
    );
    m.writeSection("New", "fresh");
    const file = readFileSync(join(dataDir, "memory", "MEMORY.md"), "utf-8");
    expect(file).toContain("legacy free text line");
    expect(file).toContain("## Existing");
    expect(file).toContain("## New");
    expect(m.readSection("Existing")).toBe("body\n");
    expect(m.readSection("New")).toBe(`${STAMP}\nfresh`);
  });

  it("round-trips savePlan / loadPlan and returns null when absent", () => {
    const m2 = new Memory(dataDir);
    expect(m2.loadPlan()).toBeNull();
    const plan = {
      name: "Build Block",
      primaryGoal: "FTP 280W",
      totalWeeks: 8,
      status: "active",
    };
    m2.savePlan(plan);
    expect(m2.loadPlan()).toEqual(plan);
  });
});
