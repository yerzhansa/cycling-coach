import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { APICallError } from "@ai-sdk/provider";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baseAgentConfig } from "./helpers/base-agent-config.js";
import { cyclingSport } from "@enduragent/sport-cycling";
import type { Sport } from "../src/sport.js";

let tempHome: string;
let origHome: string | undefined;
let dataDir: string;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "cc-taxonomy-"));
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
  return new CoachAgent(cyclingSport as unknown as Sport, baseAgentConfig(dataDir));
}

function mkAssistant(text: string) {
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
    stopReason: "stop" as const,
    timestamp: Date.now(),
  };
}

function apiError(statusCode: number): APICallError {
  return new APICallError({
    message: "server error",
    url: "https://chatgpt.com/backend-api",
    requestBodyValues: {},
    statusCode,
  });
}

describe("provider error taxonomy", () => {
  it("recovers a single AI-SDK 502 in exactly two attempts", async () => {
    let n = 0;
    const complete = vi.fn(async () => {
      n++;
      if (n === 1) throw apiError(502);
      return mkAssistant("recovered-502");
    });

    vi.useFakeTimers();
    const agent = await setupAgent(complete);
    const chatPromise = agent.chat("taxonomy-502", "hello");
    await vi.advanceTimersByTimeAsync(10_000);
    const text = await chatPromise;

    expect(text).toBe("recovered-502");
    expect(complete).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("recovers an AI-SDK network error (ECONNREFUSED on .cause) in two attempts", async () => {
    let n = 0;
    const complete = vi.fn(async () => {
      n++;
      if (n === 1) {
        const e = new TypeError("fetch failed");
        (e as Error & { cause?: unknown }).cause = { code: "ECONNREFUSED" };
        throw e;
      }
      return mkAssistant("recovered-network");
    });

    vi.useFakeTimers();
    const agent = await setupAgent(complete);
    const chatPromise = agent.chat("taxonomy-network", "hello");
    await vi.advanceTimersByTimeAsync(10_000);
    const text = await chatPromise;

    expect(text).toBe("recovered-network");
    expect(complete).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("recovers a codex 5xx via the short server-error backoff, not the rate-limit ramp", async () => {
    let n = 0;
    const complete = vi.fn(async () => {
      n++;
      if (n === 1) {
        // Mirror the bridge's marker error for a 5xx: message carries the marker,
        // status is machine-readable so normalizeError splits it into ServerError.
        const e = new Error("usage limit blocked client retry (status=503)") as Error & {
          httpStatus?: number;
        };
        e.httpStatus = 503;
        throw e;
      }
      return mkAssistant("recovered-codex-5xx");
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.useFakeTimers();
    const agent = await setupAgent(complete);

    const chatPromise = agent.chat("taxonomy-codex-5xx", "hello");
    // A short advance (under the 5s rate-limit base) suffices for the server-error backoff.
    await vi.advanceTimersByTimeAsync(5_000);
    const text = await chatPromise;

    expect(text).toBe("recovered-codex-5xx");
    expect(complete).toHaveBeenCalledTimes(2);
    const rateLimitWarn = warnSpy.mock.calls
      .map((c) => String(c[0]))
      .find((s) => s.includes("Rate limited"));
    expect(rateLimitWarn).toBeUndefined();
    vi.useRealTimers();
  });

  it("retries a codex network error at exactly one layer (no outer re-retry)", async () => {
    // pi-ai exhausts its own internal retries before the throw surfaces (the
    // bridge short-circuited it to one attempt and tagged it NetworkError), so
    // the outer loop classifies it for logging but does NOT re-enter its network
    // retry — network is retried at exactly one layer.
    const complete = vi.fn(async () => {
      const e = new Error("usage limit: fetch failed") as Error & {
        isNetworkThrow?: boolean;
        cause?: unknown;
      };
      e.isNetworkThrow = true;
      e.cause = Object.assign(new Error("fetch failed"), { code: "ECONNRESET" });
      throw e;
    });

    vi.useFakeTimers();
    const agent = await setupAgent(complete);
    const settled = agent
      .chat("taxonomy-codex-network", "hello")
      .then((v) => ({ ok: true as const, value: v }), (err: unknown) => ({ ok: false as const, err }));
    await vi.advanceTimersByTimeAsync(20_000);
    const outcome = await settled;

    // Exactly one library-level attempt; the outer loop does not retry the codex
    // network class, so complete is invoked once and the turn surfaces the error.
    expect(outcome.ok).toBe(false);
    expect(complete).toHaveBeenCalledTimes(1);
    if (!outcome.ok) {
      const { isRateLimitError } = await import("../src/agent/token-utils.js");
      // The surfaced error is a network error, never mis-routed to rate-limit.
      expect(isRateLimitError(outcome.err)).toBe(false);
    }
    vi.useRealTimers();
  });
});
