import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import { createTools } from "../src/agent/tools.js";
import { runMemoryFlush } from "../src/agent/memory-flush.js";
import { Memory } from "../src/agent/memory.js";
import type { LLM } from "../src/agent/llm.js";

// Both consumers convert the section list into a non-empty Zod enum
// (`z.enum([...] as [string, ...string[]])`). An empty list crashes Zod
// with an opaque message; the explicit guard surfaces a real diagnostic.

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

describe("createTools — empty-section guard", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "cc-guard-"));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("throws a clear error when sections is empty", () => {
    const memory = new Memory(dataDir);
    expect(() => createTools(memory, null, [])).toThrow(/at least one MemorySectionSpec/);
  });
});

describe("runMemoryFlush — empty-section guard", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "cc-guard-"));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("throws a clear error when memorySections is empty", async () => {
    const memory = new Memory(dataDir);
    await expect(
      runMemoryFlush({
        llm: noopLLM(),
        messages: [] as ModelMessage[],
        memory,
        memorySections: [],
      }),
    ).rejects.toThrow(/at least one memory section/);
  });
});
