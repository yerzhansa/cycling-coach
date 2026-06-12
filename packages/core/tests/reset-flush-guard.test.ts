import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baseAgentConfig } from "./helpers/base-agent-config.js";
import { cyclingSport } from "@enduragent/sport-cycling";
import type { Sport } from "../src/sport.js";

let tempHome: string;
let origHome: string | undefined;
let dataDir: string;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "cc-resetflush-"));
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

const STALE_TS = "2020-01-01T00:00:00.000Z";

function seedSession(chatId: string, lines: Array<{ role: string; content: string; ts: string }>) {
  const sessionsDir = join(dataDir, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(
    join(sessionsDir, `${chatId}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
    "utf-8",
  );
}

function listArchives(chatId: string): string[] {
  return readdirSync(join(dataDir, "sessions")).filter((f) =>
    f.startsWith(`${chatId}.jsonl.reset.`),
  );
}

describe("reset-path flush guards", () => {
  it("resetSession archives the session even when the memory flush throws", async () => {
    const complete = vi.fn(async () => {
      throw new Error("boom");
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const agent = await setupAgent(complete);
    seedSession("reset-guard", [
      { role: "user", content: "we agreed: hold volume this week", ts: STALE_TS },
      { role: "assistant", content: "yes - hold volume, recheck Friday", ts: STALE_TS },
    ]);

    await expect(agent.resetSession("reset-guard")).resolves.toBeUndefined();

    expect(complete).toHaveBeenCalledTimes(1);
    expect(agent.hasSession("reset-guard")).toBe(false);
    const archives = listArchives("reset-guard");
    expect(archives).toHaveLength(1);
    const archived = readFileSync(join(dataDir, "sessions", archives[0]), "utf-8");
    expect(archived).toContain("hold volume this week");
    expect(archived).toContain("recheck Friday");
    expect(
      warnSpy.mock.calls.some((c) => String(c[0]).includes("Pre-reset memory flush failed")),
    ).toBe(true);
  });

  it("freshness-expiry reset archives and the chat continues when the flush throws", async () => {
    let n = 0;
    const complete = vi.fn(async () => {
      n++;
      if (n === 1) throw new Error("boom");
      return mkAssistant("fresh-start");
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const agent = await setupAgent(complete);
    seedSession("stale-guard", [
      { role: "user", content: "old turn from a previous day", ts: STALE_TS },
      { role: "assistant", content: "old reply", ts: STALE_TS },
    ]);

    const text = await agent.chat("stale-guard", "hello");

    expect(text).toBe("fresh-start");
    expect(complete).toHaveBeenCalledTimes(2);
    const archives = listArchives("stale-guard");
    expect(archives).toHaveLength(1);
    const archived = readFileSync(join(dataDir, "sessions", archives[0]), "utf-8");
    expect(archived).toContain("old turn from a previous day");
    const freshSession = readFileSync(join(dataDir, "sessions", "stale-guard.jsonl"), "utf-8");
    expect(freshSession).toContain("hello");
    expect(freshSession).toContain("fresh-start");
    expect(freshSession).not.toContain("old turn from a previous day");
    expect(
      warnSpy.mock.calls.some((c) => String(c[0]).includes("Pre-reset memory flush failed")),
    ).toBe(true);
  });

  it("resetSession flushes and archives without a failure warn when the LLM is healthy", async () => {
    const complete = vi.fn(async () => mkAssistant("noted"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const agent = await setupAgent(complete);
    seedSession("healthy-reset", [
      { role: "user", content: "remember my FTP is 247", ts: STALE_TS },
    ]);

    await agent.resetSession("healthy-reset");

    expect(complete).toHaveBeenCalledTimes(1);
    expect(agent.hasSession("healthy-reset")).toBe(false);
    expect(listArchives("healthy-reset")).toHaveLength(1);
    expect(
      warnSpy.mock.calls.some((c) => String(c[0]).includes("Pre-reset memory flush failed")),
    ).toBe(false);
  });
});
