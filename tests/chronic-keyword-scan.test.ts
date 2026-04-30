import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import type { MemorySectionSpec } from "@cycling-coach/core";
import { Memory } from "../src/agent/memory.js";
import { runMemoryFlush } from "../src/agent/memory-flush.js";
import type { LLM } from "../src/agent/llm.js";

// LLM stub that produces no tool calls — runMemoryFlush completes quickly,
// then the post-flush scan runs. Lets us assert scan behavior without the
// real LLM rewriting the file.
function noopLLM(): LLM {
  return {
    async generate() {
      return {
        text: "",
        toolCalls: [],
        finishReason: "stop" as const,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      };
    },
  } as unknown as LLM;
}

const SECTIONS: readonly MemorySectionSpec[] = [
  { name: "cycling-history", description: "cycling-specific history" },
  { name: "medical-history", description: "chronic conditions" },
];

const NO_MESSAGES: ModelMessage[] = [];

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

// ─── post-flush chronic-keyword scan ──────────────────────────────────

describe("post-flush chronic-keyword scan", () => {
  let dataDir: string;
  let memoryFile: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "cc-scan-"));
    mkdirSync(join(dataDir, "memory"), { recursive: true });
    memoryFile = join(dataDir, "memory", "MEMORY.md");
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    warnSpy.mockRestore();
  });

  function warnEvents(): Array<Record<string, unknown>> {
    return warnSpy.mock.calls
      .map((args) => {
        try {
          return JSON.parse(String(args[0]));
        } catch {
          return null;
        }
      })
      .filter((e): e is Record<string, unknown> => e !== null);
  }

  it("does not warn when cycling-history is absent", async () => {
    const memory = new Memory(dataDir);
    await runMemoryFlush({
      llm: noopLLM(),
      messages: NO_MESSAGES,
      memory,
      memorySections: SECTIONS,
    });
    expect(
      warnEvents().filter((e) => e.event === "chronic_facts_stuck_in_cycling_history"),
    ).toHaveLength(0);
  });

  it("does not warn when cycling-history has no chronic keywords", async () => {
    writeFileSync(memoryFile, "## cycling-history\nKnee twinge resolved\n", "utf-8");
    const memory = new Memory(dataDir);
    await runMemoryFlush({
      llm: noopLLM(),
      messages: NO_MESSAGES,
      memory,
      memorySections: SECTIONS,
    });
    expect(
      warnEvents().filter((e) => e.event === "chronic_facts_stuck_in_cycling_history"),
    ).toHaveLength(0);
  });

  it("warns once with the keyword in payload when 'hypertension' is present", async () => {
    writeFileSync(
      memoryFile,
      "## cycling-history\nFTP test history; hypertension noted at intake.\n",
      "utf-8",
    );
    const memory = new Memory(dataDir);
    await runMemoryFlush({
      llm: noopLLM(),
      messages: NO_MESSAGES,
      memory,
      memorySections: SECTIONS,
    });
    const stuck = warnEvents().filter(
      (e) => e.event === "chronic_facts_stuck_in_cycling_history",
    );
    expect(stuck).toHaveLength(1);
    expect(stuck[0].keywords).toEqual(["hypertension"]);
    expect(stuck[0].hint).toContain("memory_flush");
  });

  it("collects multiple chronic keywords into one warn with all listed", async () => {
    writeFileSync(
      memoryFile,
      "## cycling-history\nHypertension; lisinopril 10mg; long-term meds.\n",
      "utf-8",
    );
    const memory = new Memory(dataDir);
    await runMemoryFlush({
      llm: noopLLM(),
      messages: NO_MESSAGES,
      memory,
      memorySections: SECTIONS,
    });
    const stuck = warnEvents().filter(
      (e) => e.event === "chronic_facts_stuck_in_cycling_history",
    );
    expect(stuck).toHaveLength(1);
    expect(stuck[0].keywords).toEqual(
      expect.arrayContaining(["hypertension", "lisinopril", "long-term"]),
    );
  });

  it('substring match catches plural variants like "medications"', async () => {
    writeFileSync(
      memoryFile,
      "## cycling-history\nOn medications since 2022.\n",
      "utf-8",
    );
    const memory = new Memory(dataDir);
    await runMemoryFlush({
      llm: noopLLM(),
      messages: NO_MESSAGES,
      memory,
      memorySections: SECTIONS,
    });
    const stuck = warnEvents().filter(
      (e) => e.event === "chronic_facts_stuck_in_cycling_history",
    );
    expect(stuck).toHaveLength(1);
    expect(stuck[0].keywords).toContain("medication");
  });

  it("matches case-insensitively", async () => {
    writeFileSync(memoryFile, "## cycling-history\nDIABETES diagnosis 2020.\n", "utf-8");
    const memory = new Memory(dataDir);
    await runMemoryFlush({
      llm: noopLLM(),
      messages: NO_MESSAGES,
      memory,
      memorySections: SECTIONS,
    });
    const stuck = warnEvents().filter(
      (e) => e.event === "chronic_facts_stuck_in_cycling_history",
    );
    expect(stuck).toHaveLength(1);
    expect(stuck[0].keywords).toContain("diabetes");
  });
});
