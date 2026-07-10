import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Memory } from "../src/memory/store.js";
import {
  warnOrphanSections,
  _resetOrphanWarnCacheForTesting,
} from "../src/memory/orphan-sections.js";
import type { MemorySectionSpec } from "../src/sport.js";

const GOALS_ONLY: readonly MemorySectionSpec[] = [{ name: "goals", description: "Athlete goals" }];

describe("orphan-section scan", () => {
  let dataDir: string;
  let memoryFile: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    _resetOrphanWarnCacheForTesting();
    dataDir = mkdtempSync(join(tmpdir(), "cc-orphan-"));
    mkdirSync(join(dataDir, "memory"), { recursive: true });
    memoryFile = join(dataDir, "memory", "MEMORY.md");
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    rmSync(dataDir, { recursive: true, force: true });
  });

  function orphanEvents(): Array<Record<string, unknown>> {
    return warnSpy.mock.calls
      .map((args: unknown[]) => {
        try {
          return JSON.parse(String(args[0]));
        } catch {
          return null;
        }
      })
      .filter(
        (e: unknown): e is Record<string, unknown> =>
          e !== null && (e as Record<string, unknown>).event === "memory_orphan_sections",
      );
  }

  it("warns once with names-only payload for a section outside the effective set", () => {
    writeFileSync(memoryFile, "## goals\nFTP 280W\n\n## random-legacy\nsecret body text\n");
    const memory = new Memory(dataDir);
    warnOrphanSections(memory, GOALS_ONLY);

    const events = orphanEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ names: ["random-legacy"] });
    expect(JSON.stringify(events[0])).not.toContain("secret body text");
  });

  it("is silent on a second scan with the same orphans", () => {
    writeFileSync(memoryFile, "## random-legacy\nbody\n");
    const memory = new Memory(dataDir);
    warnOrphanSections(memory, GOALS_ONLY);
    expect(orphanEvents()).toHaveLength(1);
    warnSpy.mockClear();
    warnOrphanSections(memory, GOALS_ONLY);
    expect(orphanEvents()).toHaveLength(0);
  });

  it("warns only for a new orphan on a subsequent scan", () => {
    writeFileSync(memoryFile, "## random-legacy\nbody\n");
    const memory = new Memory(dataDir);
    warnOrphanSections(memory, GOALS_ONLY);
    warnSpy.mockClear();

    writeFileSync(memoryFile, "## random-legacy\nbody\n\n## stray2\nmore\n");
    const memory2 = new Memory(dataDir);
    warnOrphanSections(memory2, GOALS_ONLY);
    const events = orphanEvents();
    expect(events).toHaveLength(1);
    expect(events[0].names).toEqual(["stray2"]);
  });

  it("never warns when every section is in the effective set", () => {
    writeFileSync(memoryFile, "## goals\nFTP 280W\n");
    const memory = new Memory(dataDir);
    warnOrphanSections(memory, GOALS_ONLY);
    expect(orphanEvents()).toHaveLength(0);
  });

  it("never warns on empty or missing memory", () => {
    const memory = new Memory(dataDir);
    warnOrphanSections(memory, GOALS_ONLY);
    expect(orphanEvents()).toHaveLength(0);
  });

  it("truncates a long orphan name to 40 chars in the log payload", () => {
    const longName = "x".repeat(60);
    writeFileSync(memoryFile, `## ${longName}\nbody\n`);
    const memory = new Memory(dataDir);
    warnOrphanSections(memory, GOALS_ONLY);
    const events = orphanEvents();
    expect(events).toHaveLength(1);
    expect((events[0].names as string[])[0]).toHaveLength(40);
  });

  it("never splits a surrogate pair when truncating an emoji-bearing name", () => {
    // "x" + 30 two-unit emoji = 61 UTF-16 units; a raw cut at 40 would land
    // between the halves of the 20th emoji.
    const longName = `x${"\u{1F6B4}".repeat(30)}`;
    writeFileSync(memoryFile, `## ${longName}\nbody\n`);
    const memory = new Memory(dataDir);
    warnOrphanSections(memory, GOALS_ONLY);
    const events = orphanEvents();
    expect(events).toHaveLength(1);
    const logged = (events[0].names as string[])[0];
    expect(logged).toHaveLength(39);
    const last = logged.charCodeAt(logged.length - 1);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
  });
});
