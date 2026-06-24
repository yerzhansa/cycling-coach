import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
  tempHome = mkdtempSync(join(tmpdir(), "cc-resetlock-"));
  origHome = process.env.HOME;
  process.env.HOME = tempHome;
  dataDir = join(tempHome, ".cycling-coach");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(dataDir, "memory"), { recursive: true });
  mkdirSync(join(dataDir, "sessions"), { recursive: true });
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
  const { ChatStore } = await import("../src/agent/chat-store.js");
  return { agent: new CoachAgent(cyclingSport as unknown as Sport, baseAgentConfig(dataDir)), ChatStore };
}

function mkAssistant(text: string) {
  return {
    text,
    toolCalls: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    stopReason: "stop" as const,
  };
}

function gatedTransport(): {
  complete: ReturnType<typeof vi.fn>;
  reached: Promise<void>;
  release: () => void;
} {
  let releaseTurn!: () => void;
  const turnGate = new Promise<void>((r) => {
    releaseTurn = r;
  });
  let signalReached!: () => void;
  const reached = new Promise<void>((r) => {
    signalReached = r;
  });
  const complete = vi.fn(async () => {
    signalReached();
    await turnGate;
    return mkAssistant("turn done");
  });
  return { complete, reached, release: releaseTurn };
}

describe("resetSession runs under the per-chat session lock", () => {
  it("a reset cannot interleave with an in-flight same-chat turn", async () => {
    const { complete, reached, release } = gatedTransport();
    const { agent, ChatStore } = await setupAgent(complete);
    const archiveSpy = vi.spyOn(ChatStore.prototype, "archiveAndReset");

    const turn = agent.chat("c1", "hello");
    await reached;
    expect(complete).toHaveBeenCalledTimes(1);

    const reset = agent.resetSession("c1");
    await Promise.resolve();
    expect(archiveSpy).not.toHaveBeenCalled();

    release();
    await Promise.all([turn, reset]);

    expect(archiveSpy).toHaveBeenCalledWith("c1");
    expect(archiveSpy.mock.invocationCallOrder[0]).toBeGreaterThan(
      complete.mock.invocationCallOrder[0],
    );
  });

  it("a reset for a different chat is NOT blocked by an in-flight turn", async () => {
    const { complete, reached, release } = gatedTransport();
    const { agent, ChatStore } = await setupAgent(complete);
    const archiveSpy = vi.spyOn(ChatStore.prototype, "archiveAndReset");

    const turn = agent.chat("c1", "hello");
    await reached;
    expect(complete).toHaveBeenCalledTimes(1);

    await expect(agent.resetSession("c2")).resolves.toEqual({ memoryFlushed: true });
    expect(archiveSpy).toHaveBeenCalledWith("c2");

    release();
    await turn;
  });

  it("resetSession's return value survives the lock wrap", async () => {
    const complete = vi.fn(async () => mkAssistant("ok"));
    const { agent } = await setupAgent(complete);
    await expect(agent.resetSession("c3")).resolves.toEqual({ memoryFlushed: true });
  });
});
