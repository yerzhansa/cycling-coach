import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryStore } from "@cycling-coach/core";
import { Memory } from "../src/agent/memory.js";
import { migrateCyclingLegacySections } from "../src/cycling/migrate-legacy-sections.js";

describe("migrateCyclingLegacySections", () => {
  let dataDir: string;
  let memoryFile: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "cc-migrate-"));
    memoryFile = join(dataDir, "memory", "MEMORY.md");
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  function logEvents(): Array<Record<string, unknown>> {
    return logSpy.mock.calls.map((args) => JSON.parse(String(args[0])));
  }

  function warnEvents(): Array<Record<string, unknown>> {
    return warnSpy.mock.calls.map((args) => JSON.parse(String(args[0])));
  }

  // ── per-rename behavior ──────────────────────────────────────────────

  it("renames profile → cycling-profile when only legacy exists", () => {
    const memory = new Memory(dataDir);
    writeFileSync(memoryFile, "## profile\nFTP 247W, 72kg\n", "utf-8");

    migrateCyclingLegacySections(memory);

    expect(readFileSync(memoryFile, "utf-8")).toBe("## cycling-profile\nFTP 247W, 72kg\n");
    expect(logEvents()).toContainEqual({
      event: "section_rename",
      from: "profile",
      to: "cycling-profile",
      outcome: "renamed",
    });
  });

  it("renames equipment → cycling-equipment when only legacy exists", () => {
    const memory = new Memory(dataDir);
    writeFileSync(memoryFile, "## equipment\nTrek Émonda, Wahoo Kickr\n", "utf-8");

    migrateCyclingLegacySections(memory);

    expect(readFileSync(memoryFile, "utf-8")).toBe(
      "## cycling-equipment\nTrek Émonda, Wahoo Kickr\n",
    );
    expect(logEvents()).toContainEqual({
      event: "section_rename",
      from: "equipment",
      to: "cycling-equipment",
      outcome: "renamed",
    });
  });

  it("renames health → cycling-history when only legacy exists", () => {
    const memory = new Memory(dataDir);
    writeFileSync(memoryFile, "## health\nHypertension; lisinopril 10mg\n", "utf-8");

    migrateCyclingLegacySections(memory);

    expect(readFileSync(memoryFile, "utf-8")).toBe(
      "## cycling-history\nHypertension; lisinopril 10mg\n",
    );
    expect(logEvents()).toContainEqual({
      event: "section_rename",
      from: "health",
      to: "cycling-history",
      outcome: "renamed",
    });
  });

  it("emits noop for each legacy section absent", () => {
    const memory = new Memory(dataDir);
    writeFileSync(memoryFile, "## schedule\nMon, Wed, Fri\n", "utf-8");

    migrateCyclingLegacySections(memory);

    expect(readFileSync(memoryFile, "utf-8")).toBe("## schedule\nMon, Wed, Fri\n");
    const outcomes = logEvents().map((e) => e.outcome);
    expect(outcomes).toEqual(["noop", "noop", "noop"]);
  });

  it("merges when both legacy and target exist (per rename)", () => {
    const memory = new Memory(dataDir);
    writeFileSync(
      memoryFile,
      "## cycling-profile\nFTP 250W\n## profile\nFTP 247W, 72kg\n",
      "utf-8",
    );

    migrateCyclingLegacySections(memory);

    expect(readFileSync(memoryFile, "utf-8")).toBe(
      "## cycling-profile\nFTP 250W\n\nFTP 247W, 72kg\n",
    );
    expect(logEvents()).toContainEqual({
      event: "section_rename",
      from: "profile",
      to: "cycling-profile",
      outcome: "merged",
    });
  });

  // ── end-to-end ──────────────────────────────────────────────────────

  it("migrates a realistic legacy MEMORY.md in one call; Core-shared sections untouched", () => {
    const memory = new Memory(dataDir);
    writeFileSync(
      memoryFile,
      "## profile\nFTP 247W, 72kg\n" +
        "## schedule\nMon, Wed, Fri\n" +
        "## goals\nSub-3:30 century in October\n" +
        "## equipment\nTrek Émonda\n" +
        "## health\nHypertension; lisinopril 10mg\n" +
        "## preferences\nIndoor when raining\n" +
        "## notes\nCurious about VO2max blocks\n",
      "utf-8",
    );

    migrateCyclingLegacySections(memory);

    const after = readFileSync(memoryFile, "utf-8");
    // legacy names gone
    expect(after.includes("## profile\n")).toBe(false);
    expect(after.includes("## equipment\n")).toBe(false);
    expect(after.includes("## health\n")).toBe(false);
    // cycling-prefixed names present with original content
    expect(after.includes("## cycling-profile\nFTP 247W, 72kg\n")).toBe(true);
    expect(after.includes("## cycling-equipment\nTrek Émonda\n")).toBe(true);
    expect(after.includes("## cycling-history\nHypertension; lisinopril 10mg\n")).toBe(true);
    // Core-shared sections untouched
    expect(after.includes("## schedule\nMon, Wed, Fri\n")).toBe(true);
    expect(after.includes("## goals\nSub-3:30 century in October\n")).toBe(true);
    expect(after.includes("## preferences\nIndoor when raining\n")).toBe(true);
    expect(after.includes("## notes\nCurious about VO2max blocks\n")).toBe(true);
  });

  it("is idempotent — second call yields identical file state", () => {
    const memory = new Memory(dataDir);
    writeFileSync(
      memoryFile,
      "## profile\nFTP 247W\n## equipment\nTrek\n## health\nHypertension\n",
      "utf-8",
    );

    migrateCyclingLegacySections(memory);
    const afterFirst = readFileSync(memoryFile, "utf-8");
    migrateCyclingLegacySections(memory);
    const afterSecond = readFileSync(memoryFile, "utf-8");

    expect(afterSecond).toBe(afterFirst);
    // After second call, every rename should be a noop.
    const secondCallEvents = logEvents().slice(3);
    expect(secondCallEvents.map((e) => e.outcome)).toEqual(["noop", "noop", "noop"]);
  });

  // ── failure handling ────────────────────────────────────────────────

  it("survives partial failure: prior renames stay committed, function does not throw", () => {
    // Stub MemoryStore that throws on the third call only.
    let calls = 0;
    const captured: Array<[string, string]> = [];
    const stub: MemoryStore = {
      readMemory: () => "",
      writeSection: () => {},
      readDailyNotes: () => "",
      appendDailyNote: () => {},
      savePlan: () => {},
      loadPlan: () => null,
      reload: () => {},
      getContext: () => "",
      renameSection: (from, to) => {
        calls++;
        captured.push([from, to]);
        if (calls === 3) throw new Error("disk full");
        return "renamed";
      },
    };

    expect(() => migrateCyclingLegacySections(stub)).not.toThrow();

    // All three rename attempts were made (loop continued past the failure).
    expect(captured).toEqual([
      ["profile", "cycling-profile"],
      ["equipment", "cycling-equipment"],
      ["health", "cycling-history"],
    ]);
    // First two emit success; third emits failure.
    expect(logEvents()).toHaveLength(2);
    expect(warnEvents()).toContainEqual({
      event: "section_rename_failed",
      from: "health",
      to: "cycling-history",
      error: "Error: disk full",
    });
  });
});
