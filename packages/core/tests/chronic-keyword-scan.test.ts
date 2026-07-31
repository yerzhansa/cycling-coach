import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Memory } from "../src/memory/store.js";

// ─── Memory.readSection unit tests ───────────────────────────────────

describe("Memory.readSection", () => {
  let dataDir: string;
  let memoryFile: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "cc-readsec-"));
    memoryFile = join(dataDir, "memory", "MEMORY.md");
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("returns null when file is absent", () => {
    const memory = new Memory(dataDir);
    expect(memory.readSection("cycling-history")).toBeNull();
  });

  it("returns null when section is absent", () => {
    const memory = new Memory(dataDir);
    writeFileSync(memoryFile, "## schedule\nMon, Wed, Fri\n", "utf-8");
    expect(memory.readSection("cycling-history")).toBeNull();
  });

  it("returns body without header or trailing newline", () => {
    const memory = new Memory(dataDir);
    writeFileSync(
      memoryFile,
      "## cycling-history\nKnee twinge resolved\n## schedule\nMon\n",
      "utf-8",
    );
    expect(memory.readSection("cycling-history")).toBe("Knee twinge resolved");
  });

  it("returns empty string for an empty section body", () => {
    const memory = new Memory(dataDir);
    writeFileSync(memoryFile, "## cycling-history\n## schedule\nMon\n", "utf-8");
    expect(memory.readSection("cycling-history")).toBe("");
  });
});
