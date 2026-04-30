import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baseAgentConfig } from "./helpers/base-agent-config.js";
import { cyclingSport } from "@enduragent/sport-cycling";

let tempHome: string;
let origHome: string | undefined;
let dataDir: string;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "cc-retry-"));
  origHome = process.env.HOME;
  process.env.HOME = tempHome;
  dataDir = join(tempHome, ".cycling-coach");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(dataDir, "memory"), { recursive: true });
  vi.resetModules();
});

afterEach(() => {
  process.env.HOME = origHome;
  rmSync(tempHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function setupAgent(complete: ReturnType<typeof vi.fn>) {
  const model = {
    id: "gpt-5.4",
    name: "gpt-5.4",
    api: "openai-codex-responses",
    provider: "openai-codex",
    baseUrl: "https://chatgpt.com/backend-api",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 272_000,
    maxTokens: 128_000,
  };

  vi.doMock("@mariozechner/pi-ai", () => ({
    complete,
    getModel: vi.fn(() => model),
  }));
  vi.doMock("@mariozechner/pi-ai/oauth", () => ({
    refreshOpenAICodexToken: vi.fn(),
    loginOpenAICodex: vi.fn(),
  }));
  vi.doMock("../src/auth/profiles.js", () => ({
    getFreshToken: vi.fn(async () => "token"),
    loadProfile: vi.fn(),
    saveProfile: vi.fn(),
    RefreshTokenReusedError: class extends Error {},
  }));

  const { CoachAgent } = await import("../src/agent/coach-agent.js");
  return new CoachAgent(cyclingSport, baseAgentConfig(dataDir));
}

function mkAssistant(text: string, stopReason: "stop" | "length" = "stop") {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "openai-codex-responses",
    provider: "openai-codex",
    model: "gpt-5.4",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

describe("retry loop on Codex path", () => {
  it("retries after a rate-limit error and then succeeds", async () => {
    let n = 0;
    const complete = vi.fn(async () => {
      n++;
      if (n === 1) {
        throw new Error("You have hit your ChatGPT usage limit (plus plan). Try again in ~1 min.");
      }
      return mkAssistant("recovered");
    });

    // Short-circuit backoff so the test doesn't wait 5s.
    vi.useFakeTimers();
    const agent = await setupAgent(complete);

    const chatPromise = agent.chat("test-chat", "hello");
    // Advance all timers until the promise resolves.
    await vi.advanceTimersByTimeAsync(10_000);
    const text = await chatPromise;

    expect(text).toBe("recovered");
    expect(complete).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it("propagates the error after MAX_RATE_LIMIT_ATTEMPTS exhausts", async () => {
    const complete = vi.fn(async () => {
      throw new Error("rate_limit_exceeded: too many requests");
    });
    vi.useFakeTimers();
    const agent = await setupAgent(complete);

    // Attach a catch handler immediately so Node doesn't report an unhandled rejection
    // when backoff sleeps drain before the assertion runs.
    const chatPromise = agent.chat("test-chat-2", "hello");
    const settled = chatPromise.then(
      (v) => ({ ok: true as const, value: v }),
      (err: unknown) => ({ ok: false as const, error: err }),
    );
    await vi.advanceTimersByTimeAsync(120_000);
    const outcome = await settled;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(String((outcome.error as Error).message)).toMatch(/rate/i);
    }
    expect(complete.mock.calls.length).toBeGreaterThanOrEqual(2);

    vi.useRealTimers();
  });

  it("compacts and retries after a context-overflow error on the codex path", async () => {
    let n = 0;
    const complete = vi.fn(async () => {
      n++;
      if (n === 1) {
        throw new Error("Request exceeds the maximum context length of 272000 tokens");
      }
      return mkAssistant("recovered-after-compaction");
    });

    const agent = await setupAgent(complete);
    const text = await agent.chat("test-chat-overflow", "hello");

    expect(text).toBe("recovered-after-compaction");
    // 1 overflow + 1 memory flush during compaction + 1 retry success = 3
    expect(complete).toHaveBeenCalledTimes(3);
  });
});
