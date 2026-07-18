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
  vi.doMock("../src/agent/codex/responses.js", () => ({
    codexResponses: complete,
  }));
  vi.doMock("../src/agent/codex/oauth.js", () => ({
    refreshCodexToken: vi.fn(),
    loginCodex: vi.fn(),
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

function mkAssistant(text: string, stopReason: "stop" | "length" = "stop") {
  return {
    text,
    toolCalls: [],
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
    },
    stopReason,
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

describe("rate-limit backoff clamp", () => {
  it("clamps a header-derived retry-after above the cap to RATE_LIMIT_MAX_WAIT_MS", async () => {
    let n = 0;
    const complete = vi.fn(async () => {
      n++;
      if (n === 1) {
        // Message must not match codex-bridge normalizeError patterns, or the
        // headers are stripped before reaching the retry loop.
        throw new APICallError({
          message: "quota exhausted",
          url: "https://chatgpt.com/backend-api",
          requestBodyValues: {},
          statusCode: 429,
          responseHeaders: { "retry-after": "3600" },
        });
      }
      return mkAssistant("recovered-after-clamp");
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.useFakeTimers();
    const agent = await setupAgent(complete);

    const chatPromise = agent.chat("test-chat-clamp", "hello");
    await vi.advanceTimersByTimeAsync(120_000);
    const text = await chatPromise;

    expect(text).toBe("recovered-after-clamp");
    expect(complete).toHaveBeenCalledTimes(2);
    const warnLine = warnSpy.mock.calls
      .map((c) => String(c[0]))
      .find((s) => s.includes("Rate limited"));
    expect(warnLine).toContain("waiting 120000ms");
    expect(warnLine).toContain("provider requested 3600000ms");

    vi.useRealTimers();
  });

  it("recovers a codex 5xx via the short server-error backoff, not the rate-limit ramp", async () => {
    let n = 0;
    const complete = vi.fn(async () => {
      n++;
      if (n === 1) {
        // The bridge's marker error for a 5xx: message carries the marker, but
        // the machine-readable status splits it into ServerError, not RateLimit.
        const e = new Error("usage limit blocked client retry (status=502)") as Error & {
          httpStatus?: number;
        };
        e.httpStatus = 502;
        throw e;
      }
      return mkAssistant("recovered-5xx");
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.useFakeTimers();
    const agent = await setupAgent(complete);

    const chatPromise = agent.chat("test-chat-5xx", "hello");
    // A short advance (well under RATE_LIMIT_FALLBACK_BASE_MS=5000) recovers it.
    await vi.advanceTimersByTimeAsync(5_000);
    const text = await chatPromise;

    expect(text).toBe("recovered-5xx");
    expect(complete).toHaveBeenCalledTimes(2);
    const rateLimitWarn = warnSpy.mock.calls
      .map((c) => String(c[0]))
      .find((s) => s.includes("Rate limited"));
    expect(rateLimitWarn).toBeUndefined();

    vi.useRealTimers();
  });

  it("honors a sub-cap header-derived retry-after unchanged", async () => {
    let n = 0;
    const complete = vi.fn(async () => {
      n++;
      if (n === 1) {
        throw new APICallError({
          message: "quota exhausted",
          url: "https://chatgpt.com/backend-api",
          requestBodyValues: {},
          statusCode: 429,
          responseHeaders: { "retry-after": "10" },
        });
      }
      return mkAssistant("recovered-fast");
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.useFakeTimers();
    const agent = await setupAgent(complete);

    const chatPromise = agent.chat("test-chat-subcap", "hello");
    await vi.advanceTimersByTimeAsync(10_000);
    const text = await chatPromise;

    expect(text).toBe("recovered-fast");
    expect(complete).toHaveBeenCalledTimes(2);
    const warnLine = warnSpy.mock.calls
      .map((c) => String(c[0]))
      .find((s) => s.includes("Rate limited"));
    expect(warnLine).toContain("waiting 10000ms");
    expect(warnLine).not.toContain("clamped");

    vi.useRealTimers();
  });
});
