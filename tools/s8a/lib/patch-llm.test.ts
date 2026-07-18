import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ModelTransport,
  ModelTransportDecorator,
  ModelTransportRequest,
} from "@enduragent/engine";

import { assembledHash, sha256_16 } from "./hash.js";
import {
  patchForRecord,
  patchForReplay,
  type GenerateOptsLike,
  type GenerateResultLike,
} from "./patch-llm.js";
import type { RecordedCall, S8aRecording } from "./types.js";

// Minimal fake class with the same prototype-patching contract as the real
// model seam: both this.llm and this.flushLlm resolve generate through the
// class prototype, and the instance carries a private-ish config.
function makeFakeLlmClass(
  decorator: ModelTransportDecorator,
  next: ModelTransport = {
    generate: async () => ({
      text: "live-reply",
      toolCalls: [],
      finishReason: "stop",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        inputTokenDetails: { noCacheTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
        outputTokenDetails: { textTokens: 5, reasoningTokens: 0 },
      },
      totalUsage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        inputTokenDetails: { noCacheTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
        outputTokenDetails: { textTokens: 5, reasoningTokens: 0 },
      },
      steps: 1,
    }),
  },
) {
  const transport = decorator(next);
  class FakeLLM {
    async generate(opts: GenerateOptsLike): Promise<GenerateResultLike> {
      return transport.generate({
        provider: "anthropic",
        model: "test-model",
        options: opts as ModelTransportRequest["options"],
      }) as Promise<GenerateResultLike>;
    }
  }
  return FakeLLM;
}

function recordedCall(overrides: Partial<RecordedCall> & { ordinal: number }): RecordedCall {
  const system = "the system prompt";
  const messages = [{ role: "user", content: "hello" }];
  return {
    caller: "chat",
    turn: { chatId: "c1", turnIndex: 0 },
    request: {
      shape: "messages",
      caller: "chat",
      system,
      systemSha256_16: sha256_16(system),
      templateHash: "aaaaaaaaaaaaaaaa",
      assembledHash: assembledHash(system, messages),
      messages,
      toolNames: [],
      maxSteps: 10,
      cacheKey: "cccccccccccccccc",
    },
    toolExecutions: [],
    result: {
      text: "recorded-reply",
      toolCalls: [],
      finishReason: "stop",
      usage: {},
      totalUsage: {
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        inputTokenDetails: { cacheReadTokens: 40, cacheWriteTokens: 7 },
      },
      steps: 2,
    },
    events: null,
    ...overrides,
  };
}

function recording(calls: RecordedCall[]): S8aRecording {
  return {
    s8aRecordingVersion: 1,
    scenario: "patch-llm-test",
    recordedAt: "1998-07-06T09:00:00.000Z",
    provider: "anthropic",
    model: "test-model",
    lineage: { templateHash: "aaaaaaaaaaaaaaaa", lineageVersion: "unversioned" },
    calls,
  };
}

const chatOpts: GenerateOptsLike = {
  system: "the system prompt",
  messages: [{ role: "user", content: "hello" }],
  maxSteps: 10,
  cacheKey: "cccccccccccccccc",
  caller: "chat",
};

describe("s8a replay engine", () => {
  let tempDir: string;
  afterEach(() => {
    if (tempDir !== undefined) rmSync(tempDir, { recursive: true, force: true });
  });

  function setup(calls: RecordedCall[]) {
    tempDir = mkdtempSync(join(tmpdir(), "s8a-patch-test-"));
    const handle = patchForReplay(recording(calls), "patch-llm-test");
    const FakeLLM = makeFakeLlmClass(handle.modelTransportDecorator);
    return { FakeLLM, handle };
  }

  it("serves recorded results in cursor order", async () => {
    const { FakeLLM, handle } = setup([recordedCall({ ordinal: 0 })]);
    const result = await new FakeLLM().generate(chatOpts);
    expect(result.text).toBe("recorded-reply");
    handle.finalize();
    handle.restore();
    expect(handle.state.failures).toEqual([]);
  });

  it("fails A6 on an extra generate call", async () => {
    const { FakeLLM, handle } = setup([]);
    await expect(new FakeLLM().generate(chatOpts)).rejects.toThrow(/no recorded entry/);
    handle.restore();
    const a6 = handle.state.failures.filter((f) => f.assertId === "A6");
    expect(a6).toHaveLength(1);
    expect(a6[0].detail).toContain("extra generate call at ordinal 0");
    expect(a6[0].diffFile).toBe("budget.diff");
  });

  it("fails A6 on a missing generate call (unconsumed entries)", () => {
    const { handle } = setup([recordedCall({ ordinal: 0 })]);
    handle.finalize();
    handle.restore();
    const a6 = handle.state.failures.filter((f) => f.assertId === "A6");
    expect(a6).toHaveLength(1);
    expect(a6[0].detail).toContain("missing generate call");
  });

  it("executes recorded tools against the live tool set and fails A2 on result mismatch", async () => {
    const calls = [
      recordedCall({
        ordinal: 0,
        request: {
          ...recordedCall({ ordinal: 0 }).request,
          toolNames: ["probe_tool"],
        } as RecordedCall["request"],
        toolExecutions: [
          { seq: 0, toolName: "probe_tool", input: { q: 1 }, resultCanonical: { answer: 42 } },
        ],
      }),
    ];
    const { FakeLLM, handle } = setup(calls);
    const seenInputs: unknown[] = [];
    await new FakeLLM().generate({
      ...chatOpts,
      tools: {
        probe_tool: {
          execute: async (input: unknown) => {
            seenInputs.push(input);
            return { answer: 43 };
          },
        },
      },
    });
    handle.restore();
    expect(seenInputs).toEqual([{ q: 1 }]);
    const a2 = handle.state.failures.filter((f) => f.assertId === "A2");
    expect(a2).toHaveLength(1);
    expect(a2[0].diffFile).toBe("tool-calls.diff");
  });

  it("fails A3 inline on request drift (cacheKey)", async () => {
    const { FakeLLM, handle } = setup([recordedCall({ ordinal: 0 })]);
    await new FakeLLM().generate({ ...chatOpts, cacheKey: "dddddddddddddddd" });
    handle.restore();
    const a3 = handle.state.failures.filter((f) => f.assertId === "A3");
    expect(a3.some((f) => f.detail.includes("cacheKey"))).toBe(true);
  });

  it("records a PENDING (not an inline failure) for a chat-caller system mismatch", async () => {
    const { FakeLLM, handle } = setup([recordedCall({ ordinal: 0 })]);
    await new FakeLLM().generate({ ...chatOpts, system: "a different system prompt" });
    handle.restore();
    expect(handle.state.failures.filter((f) => f.assertId === "A1" || f.assertId === "A3")).toEqual([]);
    expect(handle.state.pendings).toHaveLength(1);
    expect(handle.state.pendings[0].assertId).toBe("A3");
    expect(handle.state.pendings[0].recordedTemplateHash).toBe("aaaaaaaaaaaaaaaa");
  });

  it("fails a flush-caller system mismatch inline (no supersession path)", async () => {
    const base = recordedCall({ ordinal: 0, caller: "flush" });
    const req = { ...base.request, caller: "flush", cacheKey: null } as RecordedCall["request"];
    if (req.shape === "messages") delete req.templateHash;
    const { FakeLLM, handle } = setup([{ ...base, caller: "flush", request: req }]);
    await new FakeLLM().generate({
      ...chatOpts,
      system: "a different system prompt",
      cacheKey: undefined,
      caller: "flush",
    });
    handle.restore();
    expect(handle.state.pendings).toEqual([]);
    const inline = handle.state.failures.filter((f) => f.assertId === "A3");
    expect(inline).toHaveLength(1);
    expect(inline[0].diffFile).toBe("system-prompt.diff");
  });

  it("returns replay data without delegating to the canonical transport", async () => {
    const { FakeLLM, handle } = setup([recordedCall({ ordinal: 0 })]);
    const result = await new FakeLLM().generate(chatOpts);
    handle.restore();
    expect(result.text).toBe("recorded-reply");
  });

  it("replays recorded text deltas in order and accepts legacy null", async () => {
    const call = recordedCall({ ordinal: 0 });
    call.events = [
      { type: "text_delta", delta: "one" },
      { type: "text_delta", delta: " two" },
    ];
    const { FakeLLM, handle } = setup([call, recordedCall({ ordinal: 1 })]);
    const deltas: string[] = [];
    const result = await new FakeLLM().generate({
      ...chatOpts,
      onTextDelta: (delta) => deltas.push(delta),
    });
    await new FakeLLM().generate(chatOpts);
    handle.finalize();
    handle.restore();
    expect(result.text).toBe("recorded-reply");
    expect(deltas).toEqual(["one", " two"]);
    expect(handle.state.failures).toEqual([]);
  });

  it("rejects malformed recorded text deltas before delivery", async () => {
    const call = recordedCall({ ordinal: 0 });
    (call as unknown as { events: unknown }).events = [
      { type: "text_delta", delta: "one", extra: true },
    ];
    const { FakeLLM, handle } = setup([call]);
    const observer = vi.fn();
    await expect(
      new FakeLLM().generate({ ...chatOpts, onTextDelta: observer }),
    ).rejects.toThrow(/malformed text_delta/);
    expect(observer).not.toHaveBeenCalled();
    handle.restore();
  });
});

describe("s8a record engine", () => {
  it("captures request shape, tool executions, and result without mutating the caller's tools", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "s8a-record-test-"));
    try {
      const next: ModelTransport = {
        generate: async (request) => {
          const opts = request.options as GenerateOptsLike;
          // Simulate the SDK executing a tool during the call.
          await opts.tools?.probe_tool.execute?.({ q: 1 }, { toolCallId: "t1", messages: [] });
          request.options.onTextDelta?.("one");
          request.options.onTextDelta?.(" two");
          return {
            text: "reply",
            toolCalls: [],
            finishReason: "stop",
            usage: {
              inputTokens: 1,
              outputTokens: 2,
              totalTokens: 3,
              inputTokenDetails: { noCacheTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
              outputTokenDetails: { textTokens: 2, reasoningTokens: 0 },
            },
            totalUsage: {
              inputTokens: 1,
              outputTokens: 2,
              totalTokens: 3,
              inputTokenDetails: { noCacheTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
              outputTokenDetails: { textTokens: 2, reasoningTokens: 0 },
            },
            steps: 1,
          };
        },
      };
      const tools = {
        probe_tool: { execute: async () => ({ answer: 42 }) },
      };
      const originalExecute = tools.probe_tool.execute;
      const handle = patchForRecord();
      const FakeLLM = makeFakeLlmClass(handle.modelTransportDecorator, next);
      handle.setCurrentTurn({ chatId: "c1", turnIndex: 0 });
      await new FakeLLM().generate({ ...chatOpts, tools });
      handle.restore();

      expect(tools.probe_tool.execute).toBe(originalExecute);
      expect(handle.calls).toHaveLength(1);
      const call = handle.calls[0];
      expect(call.turn).toEqual({ chatId: "c1", turnIndex: 0 });
      expect(call.request.shape).toBe("messages");
      if (call.request.shape === "messages") {
        expect(call.request.toolNames).toEqual(["probe_tool"]);
        expect(call.request.systemSha256_16).toBe(sha256_16("the system prompt"));
      }
      expect(call.toolExecutions).toEqual([
        { seq: 0, toolName: "probe_tool", input: { q: 1 }, resultCanonical: { answer: 42 } },
      ]);
      expect(call.result.text).toBe("reply");
      expect(call.events).toEqual([
        { type: "text_delta", delta: "one" },
        { type: "text_delta", delta: " two" },
      ]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("captures compact calls as prompt-shaped requests", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "s8a-record-test-"));
    try {
      const handle = patchForRecord();
      const FakeLLM = makeFakeLlmClass(handle.modelTransportDecorator);
      await new FakeLLM().generate({ prompt: "summarize this", maxOutputTokens: 512, caller: "compact" });
      handle.restore();
      const req = handle.calls[0].request;
      expect(req.shape).toBe("prompt");
      if (req.shape === "prompt") {
        expect(req.prompt).toBe("summarize this");
        expect(req.promptSha256_16).toBe(sha256_16("summarize this"));
        expect(req.maxOutputTokens).toBe(512);
        expect(req.cacheKey).toBeNull();
      }
      expect(handle.calls[0].events).toBeNull();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it.each(["sync-triage", "dream"] as const)(
    "rejects unsupported %s callers before delegation or recording",
    async (caller) => {
      const next = { generate: vi.fn() } satisfies ModelTransport;
      const handle = patchForRecord();
      const FakeLLM = makeFakeLlmClass(handle.modelTransportDecorator, next);
      await expect(new FakeLLM().generate({ ...chatOpts, caller })).rejects.toThrow(
        `unsupported Tier-R caller: ${caller}`,
      );
      expect(next.generate).not.toHaveBeenCalled();
      expect(handle.calls).toEqual([]);
    },
  );
});
