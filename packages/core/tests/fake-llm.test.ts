import { describe, it, expect } from "vitest";
import type { ModelMessage } from "ai";
import { createFakeLLM } from "./helpers/fake-llm.js";

describe("createFakeLLM", () => {
  it("serves queued turns in order, with string shorthand defaults", async () => {
    const llm = createFakeLLM(["first", { text: "second", finishReason: "length" }]);
    const a = await llm.generate({ prompt: "p1" });
    const b = await llm.generate({ prompt: "p2" });
    expect(a.text).toBe("first");
    expect(a.finishReason).toBe("stop");
    expect(a.toolCalls).toEqual([]);
    expect(a.usage.totalTokens).toBe(0);
    expect(b.text).toBe("second");
    expect(b.finishReason).toBe("length");
  });

  it("serves the empty turn once the queue is exhausted", async () => {
    const llm = createFakeLLM(["only"]);
    await llm.generate({ prompt: "p1" });
    const out = await llm.generate({ prompt: "p2" });
    expect(out.text).toBe("");
    expect(out.toolCalls).toEqual([]);
    expect(out.finishReason).toBe("stop");
  });

  it("repeatLast replays the final turn after exhaustion", async () => {
    const llm = createFakeLLM(["a", "b"], { repeatLast: true });
    await llm.generate({ prompt: "1" });
    await llm.generate({ prompt: "2" });
    const third = await llm.generate({ prompt: "3" });
    expect(third.text).toBe("b");
  });

  it("scripts per-turn toolCalls and usage overrides", async () => {
    const llm = createFakeLLM([
      {
        toolCalls: [{ type: "tool-call", toolCallId: "t1", toolName: "memory_write", input: {} }],
        usage: { inputTokens: 11, outputTokens: 5, totalTokens: 16 },
      },
    ]);
    const out = await llm.generate({ prompt: "p" });
    expect(out.toolCalls).toHaveLength(1);
    expect(out.toolCalls[0]?.toolName).toBe("memory_write");
    expect(out.usage.inputTokens).toBe(11);
    expect(out.usage.totalTokens).toBe(16);
  });

  it("rejects when the turn scripts an error, then serves the next turn", async () => {
    const boom = new Error("provider down");
    const llm = createFakeLLM([{ error: boom }, "recovered"]);
    await expect(llm.generate({ prompt: "p1" })).rejects.toThrow("provider down");
    const out = await llm.generate({ prompt: "p2" });
    expect(out.text).toBe("recovered");
  });

  it("captures prompts, messages, and full opts", async () => {
    const llm = createFakeLLM();
    const messages: ModelMessage[] = [{ role: "user", content: "hi" }];
    await llm.generate({ prompt: "a prompt", system: "sys" });
    await llm.generate({ messages });
    expect(llm.capturedPrompts).toEqual(["a prompt"]);
    expect(llm.capturedMessages).toEqual([messages]);
    expect(llm.capturedOpts).toHaveLength(2);
    expect(llm.capturedOpts[0]?.system).toBe("sys");
  });
});
