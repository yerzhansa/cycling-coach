import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import { Memory } from "../../core/src/memory/store.js";
import { CHRONIC_KEYWORDS, runMemoryFlush } from "../src/agent/memory-flush.js";
import type { MemorySectionSpec } from "../src/sport.js";
import { createFakeLLM } from "./helpers/fake-llm.js";

const SECTIONS: readonly MemorySectionSpec[] = [
  { name: "cycling-history", description: "cycling-specific history" },
  { name: "medical-history", description: "chronic conditions" },
];
const NO_MESSAGES: ModelMessage[] = [];

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
      .map((args: unknown[]) => {
        try {
          return JSON.parse(String(args[0]));
        } catch {
          return null;
        }
      })
      .filter((event: unknown): event is Record<string, unknown> => event !== null);
  }

  async function flush(body?: string): Promise<Array<Record<string, unknown>>> {
    if (body !== undefined) writeFileSync(memoryFile, `## cycling-history\n${body}\n`, "utf-8");
    await runMemoryFlush({
      llm: createFakeLLM(),
      messages: NO_MESSAGES,
      memory: new Memory(dataDir),
      memorySections: SECTIONS,
    });
    return warnEvents().filter(
      (event) => event.event === "chronic_facts_stuck_in_cycling_history",
    );
  }

  it("does not warn without a chronic keyword", async () => {
    expect(await flush()).toHaveLength(0);
    expect(await flush("Knee twinge resolved")).toHaveLength(0);
  });

  it("reports a single aggregate count case-insensitively", async () => {
    const events = await flush("Hypertension; lisinopril 10mg; long-term meds.");
    expect(events).toHaveLength(1);
    expect(events[0].matchCount).toBe(3);
    expect(events[0].hint).toContain("memory_flush");
  });

  it("matches keyword substrings without logging the tokens", async () => {
    const events = await flush(`medications; ${CHRONIC_KEYWORDS.join("; ")}`);
    expect(events).toHaveLength(1);
    expect(events[0].matchCount).toBe(CHRONIC_KEYWORDS.length);
    expect(events[0].keywords).toBeUndefined();
    const { event: _event, ...payload } = events[0];
    const serialized = JSON.stringify(payload).toLowerCase();
    for (const keyword of CHRONIC_KEYWORDS) expect(serialized).not.toContain(keyword);
  });
});
