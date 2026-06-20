import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baseAgentConfig } from "./helpers/base-agent-config.js";
import { cyclingSport } from "@enduragent/sport-cycling";
import type { Sport } from "../src/sport.js";

// The rate-limit retry cap in coach-agent.ts (a module-local const there).
const MAX_RATE_LIMIT_ATTEMPTS = 3;

let tempHome: string;
let origHome: string | undefined;
let dataDir: string;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "cc-turnoutcome-"));
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

const FLUSH_MARKER = "reviewing a conversation to extract and save important athlete";

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

interface OutcomeLine {
  event: string;
  turnId?: string;
  chatId?: string;
  ok?: boolean;
  error_class?: string;
  overflowAttempts?: number;
  timeoutAttempts?: number;
  rateLimitAttempts?: number;
  duration_ms?: number;
  compactions?: number;
}

function readOutcomeLines(): OutcomeLine[] {
  const path = join(dataDir, "logs", "log.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as OutcomeLine)
    .filter((l) => l.event === "turn_outcome");
}

function sessionFile(chatId: string): string {
  return join(dataDir, "sessions", `${chatId}.jsonl`);
}

function readSession(chatId: string): string | null {
  const path = sessionFile(chatId);
  return existsSync(path) ? readFileSync(path, "utf-8") : null;
}

describe("per-turn outcome line", () => {
  it("a successful turn emits exactly one ok:true line", async () => {
    const complete = vi.fn(async (_model: unknown, context: { systemPrompt?: string }) => {
      const sys = context.systemPrompt ?? "";
      if (sys.includes(FLUSH_MARKER)) return mkAssistant("facts noted");
      if (sys.length === 0) return mkAssistant("summary");
      return mkAssistant("all good");
    });
    const agent = await setupAgent(complete);

    const text = await agent.chat("ok-chat", "hello");
    expect(text).toBe("all good");

    const lines = readOutcomeLines();
    expect(lines).toHaveLength(1);
    const line = lines[0];
    expect(line.ok).toBe(true);
    expect(line.error_class).toBeUndefined();
    expect(typeof line.turnId).toBe("string");
    expect(line.turnId!.length).toBeGreaterThan(0);
    expect(line.chatId).toBe("ok-chat");
    expect(typeof line.duration_ms).toBe("number");
    expect(line.duration_ms).toBeGreaterThanOrEqual(0);
    expect(line.overflowAttempts).toBe(0);
    expect(line.timeoutAttempts).toBe(0);
    expect(line.rateLimitAttempts).toBe(0);
  });

  it("a rate-limit retries-exhausted turn emits exactly one ok:false line with error_class rate_limit", async () => {
    const complete = vi.fn(async (_model: unknown, context: { systemPrompt?: string }) => {
      const sys = context.systemPrompt ?? "";
      if (sys.includes(FLUSH_MARKER)) return mkAssistant("facts noted");
      if (sys.length === 0) return mkAssistant("summary");
      throw new Error("You have hit your rate limit. Try again later.");
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.useFakeTimers();
    const agent = await setupAgent(complete);

    const p = agent.chat("fail-chat", "hello");
    const settled = p.then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await vi.advanceTimersByTimeAsync(600_000);
    const outcome = await settled;
    vi.useRealTimers();

    expect(outcome.ok).toBe(false);

    const lines = readOutcomeLines();
    expect(lines).toHaveLength(1);
    expect(lines[0].ok).toBe(false);
    expect(lines[0].error_class).toBe("rate_limit");
    expect(lines[0].rateLimitAttempts).toBe(MAX_RATE_LIMIT_ATTEMPTS);
  });

  it("a retried-then-succeeded turn emits one ok:true line with the recovery counters", async () => {
    let mainCalls = 0;
    const complete = vi.fn(async (_model: unknown, context: { systemPrompt?: string }) => {
      const sys = context.systemPrompt ?? "";
      if (sys.includes(FLUSH_MARKER)) return mkAssistant("facts noted");
      if (sys.length === 0) return mkAssistant("summary");
      mainCalls++;
      if (mainCalls === 1) {
        throw new Error("Request exceeds the maximum context length of 272000 tokens");
      }
      return mkAssistant("recovered reply");
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const agent = await setupAgent(complete);

    const text = await agent.chat("recover-chat", "hello");
    expect(text).toBe("recovered reply");

    const lines = readOutcomeLines();
    expect(lines).toHaveLength(1);
    expect(lines[0].ok).toBe(true);
    expect(lines[0].overflowAttempts).toBe(1);
    expect(lines[0].compactions).toBeGreaterThanOrEqual(1);
  });

  it("leaves the session JSONL byte-identical on a failed turn", async () => {
    const complete = vi.fn(async (_model: unknown, context: { systemPrompt?: string }) => {
      const sys = context.systemPrompt ?? "";
      if (sys.includes(FLUSH_MARKER)) return mkAssistant("facts noted");
      if (sys.length === 0) return mkAssistant("summary");
      throw new Error("You have hit your rate limit. Try again later.");
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.useFakeTimers();
    const agent = await setupAgent(complete);

    const before = readSession("fail-chat");

    const p = agent.chat("fail-chat", "hello");
    const settled = p.then(
      () => undefined,
      () => undefined,
    );
    await vi.advanceTimersByTimeAsync(600_000);
    await settled;
    vi.useRealTimers();

    const after = readSession("fail-chat");
    expect(after).toBe(before);
  });

  it("does not reject when the outcome sink throws", async () => {
    const complete = vi.fn(async (_model: unknown, context: { systemPrompt?: string }) => {
      const sys = context.systemPrompt ?? "";
      if (sys.includes(FLUSH_MARKER)) return mkAssistant("facts noted");
      if (sys.length === 0) return mkAssistant("summary");
      return mkAssistant("all good");
    });
    // Force the child logger's structured emit to throw so emitTurnOutcome's
    // swallowing try/catch is exercised — the turn must still resolve.
    vi.doMock("../src/logging/index.js", async () => {
      const actual = await vi.importActual<typeof import("../src/logging/index.js")>(
        "../src/logging/index.js",
      );
      return {
        ...actual,
        createSubsystemLogger: () => ({
          debug: () => {},
          info: () => {
            throw new Error("sink boom");
          },
          warn: () => {},
          error: () => {},
        }),
      };
    });
    const agent = await setupAgent(complete);

    await expect(agent.chat("sink-chat", "hello")).resolves.toBe("all good");
  });
});
