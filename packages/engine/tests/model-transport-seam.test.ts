import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  EngineConfig,
  EngineHostPorts,
  ModelTransportDecorator,
  UsageLedgerLine,
} from "../src/host-ports.js";

const config: EngineConfig = {
  dataSource: "platform",
  llm: { provider: "anthropic", model: "claude-sonnet-4-6", apiKey: "test" },
  session: {
    historyTokenBudgetRatio: 0.3,
    idleMinutes: 0,
    dailyResetHour: 4,
    resetArchiveRetentionDays: 0,
    timezone: "UTC",
  },
  contextWindowTokens: 1_000_000,
  compactContextWindowTokens: 200_000,
};

function result(text: string) {
  return {
    text,
    toolCalls: [],
    finishReason: "stop" as const,
    usage: {
      inputTokens: 3,
      outputTokens: 2,
      totalTokens: 5,
      inputTokenDetails: { noCacheTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 },
      outputTokenDetails: { textTokens: 2, reasoningTokens: 0 },
    },
    totalUsage: {
      inputTokens: 3,
      outputTokens: 2,
      totalTokens: 5,
      inputTokenDetails: { noCacheTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 },
      outputTokenDetails: { textTokens: 2, reasoningTokens: 0 },
    },
    steps: 1,
  };
}

async function loadLlm(
  decorator: ModelTransportDecorator,
  generateText: ReturnType<typeof vi.fn>,
): Promise<{ llm: import("../src/llm.js").LLM; usage: UsageLedgerLine[] }> {
  vi.doMock("ai", async () => {
    const actual = await vi.importActual<typeof import("ai")>("ai");
    return { ...actual, generateText };
  });
  const { LLM } = await import("../src/llm.js");
  const usage: UsageLedgerLine[] = [];
  let now = 10;
  const ports: Pick<
    EngineHostPorts,
    "usage" | "now" | "getAccessToken" | "classifyFailure" | "modelTransportDecorator"
  > = {
    usage: { append: (line) => usage.push(line) },
    now: () => now++,
    getAccessToken: async () => "token",
    classifyFailure: () => "unknown",
    modelTransportDecorator: decorator,
  };
  return { llm: new LLM(config, ports), usage };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("model transport decorator", () => {
  it("record mode delegates exactly once through the canonical request", async () => {
    const sdkGenerate = vi.fn(async () => ({ ...result("recorded"), steps: [{}] }));
    let delegated = 0;
    const decorator: ModelTransportDecorator = (next) => ({
      generate: async (request) => {
        delegated++;
        return next.generate(request);
      },
    });
    const { llm, usage } = await loadLlm(decorator, sdkGenerate);
    await expect(llm.generate({ prompt: "hello", caller: "chat" })).resolves.toMatchObject({
      text: "recorded",
    });
    expect(delegated).toBe(1);
    expect(sdkGenerate).toHaveBeenCalledTimes(1);
    expect(usage).toHaveLength(1);
  });

  it("replay mode delegates zero times while the outer path appends one usage line", async () => {
    const sdkGenerate = vi.fn(async () => ({ ...result("unexpected"), steps: [{}] }));
    const replay = result("replayed");
    const decorator: ModelTransportDecorator = () => ({
      generate: async () => replay,
    });
    const { llm, usage } = await loadLlm(decorator, sdkGenerate);
    await expect(llm.generate({ prompt: "hello", caller: "chat" })).resolves.toEqual(replay);
    expect(sdkGenerate).not.toHaveBeenCalled();
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      kind: "generate",
      caller: "chat",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      totalTokens: 5,
    });
  });
});
