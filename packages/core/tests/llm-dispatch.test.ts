import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import type { Config } from "../src/config.js";

function codexConfig(): Config {
  return {
    llm: { provider: "openai-codex", model: "gpt-5.4", apiKey: "", authProfile: "openai-codex" },
    intervals: { apiKey: "", athleteId: "0" },
    telegram: { botToken: "" },
    session: { historyTokenBudgetRatio: 0.3, idleMinutes: 0, dailyResetHour: 4 },
    contextWindowTokens: 272_000,
    dataDir: "/tmp/cc-dispatch-test",
  };
}

type Captured = { stepLimit: number | undefined; called: number };

async function runCodex(opts: Parameters<import("../src/llm.js").LLM["generate"]>[0]): Promise<Captured> {
  const captured: Captured = { stepLimit: undefined, called: 0 };
  vi.doMock("../src/agent/codex-bridge.js", () => ({
    codexGenerateText: vi.fn(async (o: { stepLimit?: number }) => {
      captured.stepLimit = o.stepLimit;
      captured.called++;
      return { text: "ok", toolCalls: [], finishReason: "stop", usage: {} };
    }),
  }));
  const { LLM } = await import("../src/llm.js");
  const llm = new LLM(codexConfig());
  await llm.generate(opts);
  return captured;
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("LLM dispatch — codex path forwards maxSteps to bridge", () => {
  it("forwards opts.maxSteps to the bridge as stepLimit", async () => {
    const captured = await runCodex({
      messages: [{ role: "user", content: "hi" }],
      maxSteps: 5,
    });
    expect(captured.called).toBe(1);
    expect(captured.stepLimit).toBe(5);
  });

  it("forwards undefined when maxSteps is not provided (bridge applies its own default)", async () => {
    const captured = await runCodex({ messages: [{ role: "user", content: "hi" }] });
    expect(captured.stepLimit).toBeUndefined();
  });
});
