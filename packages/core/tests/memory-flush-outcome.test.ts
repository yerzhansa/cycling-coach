import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage, ToolSet } from "ai";
import { Memory } from "../src/memory/store.js";
import {
  runMemoryFlush,
  FLUSH_ZERO_WRITE_MIN_MESSAGES,
  FLUSH_SHRINK_MIN_CHARS,
} from "../src/agent/memory-flush.js";
import type { MemorySectionSpec } from "../src/sport.js";
import type { GenerateOpts } from "../src/llm-types.js";
import { createFakeLLM, type FakeLLM, type QueuedTurn } from "./helpers/fake-llm.js";

const SECTIONS: readonly MemorySectionSpec[] = [
  { name: "goals", description: "Athlete goals" },
  { name: "medical-history", description: "chronic conditions" },
];

const NON_TRIVIAL: ModelMessage[] = [
  { role: "user", content: "Did 3x12 at threshold today, knee felt fine" },
  { role: "assistant", content: "Good - keep the volume, recheck Friday" },
  { role: "user", content: "Also switching to morning rides from next week" },
  { role: "assistant", content: "Noted - I will plan intensity for mornings" },
];

const TRIVIAL: ModelMessage[] = [{ role: "user", content: "thanks" }];

function drivenLLM(turns: QueuedTurn[], drive: (tools: ToolSet) => Promise<void>): FakeLLM {
  const inner = createFakeLLM(turns);
  return {
    ...inner,
    async generate(opts: GenerateOpts) {
      if (opts.tools) await drive(opts.tools);
      return inner.generate(opts);
    },
  } as FakeLLM;
}

describe("runMemoryFlush outcome detection", () => {
  let dataDir: string;
  let memoryFile: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "cc-flushout-"));
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
      .filter((e: unknown): e is Record<string, unknown> => e !== null);
  }

  function eventsNamed(name: string): Array<Record<string, unknown>> {
    return warnEvents().filter((e) => e.event === name);
  }

  it("zero-write flush on a non-trivial conversation warns and reports writes: 0", async () => {
    const memory = new Memory(dataDir);
    const outcome = await runMemoryFlush({
      llm: createFakeLLM([""]),
      messages: NON_TRIVIAL,
      memory,
      memorySections: SECTIONS,
    });
    expect(outcome.writes).toBe(0);
    expect(outcome.ledgerAppends).toBe(0);
    expect(outcome.finishReason).toBe("stop");
    const zero = eventsNamed("memory_flush_zero_writes");
    expect(zero).toHaveLength(1);
    expect(zero[0].messageCount).toBe(NON_TRIVIAL.length);
    expect(NON_TRIVIAL.length).toBeGreaterThanOrEqual(FLUSH_ZERO_WRITE_MIN_MESSAGES);
  });

  it("zero-write flush on a trivial conversation stays silent", async () => {
    const memory = new Memory(dataDir);
    const outcome = await runMemoryFlush({
      llm: createFakeLLM([""]),
      messages: TRIVIAL,
      memory,
      memorySections: SECTIONS,
    });
    expect(outcome.writes).toBe(0);
    expect(eventsNamed("memory_flush_zero_writes")).toHaveLength(0);
  });

  it("ledger-append-only flush counts the append and does not warn", async () => {
    const memory = new Memory(dataDir);
    const llm = drivenLLM([""], async (tools) => {
      await tools.ledger_append.execute!(
        { date: "2026-06-01", kind: "decision", text: "hold volume this week" },
        {} as never,
      );
    });
    const outcome = await runMemoryFlush({
      llm,
      messages: NON_TRIVIAL,
      memory,
      memorySections: SECTIONS,
    });
    expect(outcome.writes).toBe(0);
    expect(outcome.ledgerAppends).toBe(1);
    expect(eventsNamed("memory_flush_zero_writes")).toHaveLength(0);
  });

  it("counts executed memory_write calls in the outcome", async () => {
    const memory = new Memory(dataDir);
    const llm = drivenLLM([""], async (tools) => {
      await tools.memory_write.execute!(
        { section: "goals", content: "Target FTP 280W by August" },
        {} as never,
      );
      await tools.memory_write.execute!(
        { section: "medical-history", content: "Asthma, mild" },
        {} as never,
      );
    });
    const outcome = await runMemoryFlush({
      llm,
      messages: NON_TRIVIAL,
      memory,
      memorySections: SECTIONS,
    });
    expect(outcome.writes).toBe(2);
    expect(eventsNamed("memory_flush_zero_writes")).toHaveLength(0);
  });

  it("warns with char counts only when a section shrinks past the ratio", async () => {
    const body = "hypertension; lisinopril 10mg; ".repeat(20);
    writeFileSync(memoryFile, `## medical-history\n${body}\n`, "utf-8");
    const memory = new Memory(dataDir);
    const llm = drivenLLM([""], async (tools) => {
      await tools.memory_write.execute!(
        { section: "medical-history", content: "Asthma, mild" },
        {} as never,
      );
    });
    const outcome = await runMemoryFlush({
      llm,
      messages: NON_TRIVIAL,
      memory,
      memorySections: SECTIONS,
    });
    const shrunk = eventsNamed("memory_flush_section_shrunk");
    expect(shrunk).toHaveLength(1);
    expect(shrunk[0].section).toBe("medical-history");
    expect(shrunk[0].beforeChars).toBe(body.length);
    expect(shrunk[0].afterChars).toBe("Asthma, mild".length);
    expect(JSON.stringify(shrunk[0]).toLowerCase()).not.toContain("lisinopril");
    expect(outcome.shrunkSections).toEqual([
      { section: "medical-history", beforeChars: body.length, afterChars: "Asthma, mild".length },
    ]);
  });

  it("does not warn when the shrinking section is below the size floor", async () => {
    const body = "a".repeat(FLUSH_SHRINK_MIN_CHARS - 100);
    writeFileSync(memoryFile, `## goals\n${body}\n`, "utf-8");
    const memory = new Memory(dataDir);
    const llm = drivenLLM([""], async (tools) => {
      await tools.memory_write.execute!({ section: "goals", content: "short" }, {} as never);
    });
    const outcome = await runMemoryFlush({
      llm,
      messages: NON_TRIVIAL,
      memory,
      memorySections: SECTIONS,
    });
    expect(eventsNamed("memory_flush_section_shrunk")).toHaveLength(0);
    expect(outcome.shrunkSections).toEqual([]);
  });

  it("does not warn on a modest shrink within the ratio", async () => {
    writeFileSync(memoryFile, `## goals\n${"a".repeat(400)}\n`, "utf-8");
    const memory = new Memory(dataDir);
    const llm = drivenLLM([""], async (tools) => {
      await tools.memory_write.execute!(
        { section: "goals", content: "b".repeat(300) },
        {} as never,
      );
    });
    const outcome = await runMemoryFlush({
      llm,
      messages: NON_TRIVIAL,
      memory,
      memorySections: SECTIONS,
    });
    expect(eventsNamed("memory_flush_section_shrunk")).toHaveLength(0);
    expect(outcome.shrunkSections).toEqual([]);
  });

  it("passes finishReason and usage through from the generate result", async () => {
    const memory = new Memory(dataDir);
    const outcome = await runMemoryFlush({
      llm: createFakeLLM([{ text: "", finishReason: "length", usage: { outputTokens: 7 } }]),
      messages: TRIVIAL,
      memory,
      memorySections: SECTIONS,
    });
    expect(outcome.finishReason).toBe("length");
    expect(outcome.usage.outputTokens).toBe(7);
  });

  it("flushing twice with a deterministic writer leaves MEMORY.md byte-identical", async () => {
    const memory = new Memory(dataDir);
    const content = "Target FTP 280W by August";
    const drive = async (tools: ToolSet) => {
      await tools.memory_write.execute!({ section: "goals", content }, {} as never);
    };
    const first = await runMemoryFlush({
      llm: drivenLLM([""], drive),
      messages: NON_TRIVIAL,
      memory,
      memorySections: SECTIONS,
    });
    const afterFirst = readFileSync(memoryFile, "utf-8");
    const second = await runMemoryFlush({
      llm: drivenLLM([""], drive),
      messages: NON_TRIVIAL,
      memory,
      memorySections: SECTIONS,
    });
    const afterSecond = readFileSync(memoryFile, "utf-8");
    expect(first.writes).toBe(1);
    expect(second.writes).toBe(1);
    expect(afterSecond).toBe(afterFirst);
  });

  it("an LLM error still propagates and emits no detection events", async () => {
    const memory = new Memory(dataDir);
    await expect(
      runMemoryFlush({
        llm: createFakeLLM([{ error: new Error("boom") }]),
        messages: NON_TRIVIAL,
        memory,
        memorySections: SECTIONS,
      }),
    ).rejects.toThrow("boom");
    expect(eventsNamed("memory_flush_zero_writes")).toHaveLength(0);
    expect(eventsNamed("memory_flush_section_shrunk")).toHaveLength(0);
  });
});
