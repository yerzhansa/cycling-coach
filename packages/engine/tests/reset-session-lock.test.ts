import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TurnEvent } from "@enduragent/coach-contract";
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
  mkdirSync(join(dataDir, "sessions"), { recursive: true, mode: 0o700 });
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
  const ports = { ...baseAgentConfig(dataDir), now: () => 0 };
  return {
    agent: new CoachAgent(cyclingSport as unknown as Sport, ports),
    chatStore: ports.chatStore,
    transcriptWriter: ports.transcriptWriter,
  };
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
    const { agent, chatStore } = await setupAgent(complete);
    const resetSpy = vi.spyOn(chatStore, "resetConversation");

    const turn = agent.chat("c1", "hello");
    await reached;
    expect(complete).toHaveBeenCalledTimes(1);

    const reset = agent.resetSession("c1");
    await Promise.resolve();
    expect(resetSpy).not.toHaveBeenCalled();

    release();
    await Promise.all([turn, reset]);

    expect(resetSpy).toHaveBeenCalledWith({
      chatId: "c1",
      boundaryAt: "1970-01-01T00:00:00.000Z",
      reason: "explicit-reset",
    });
    expect(resetSpy.mock.invocationCallOrder[0]).toBeGreaterThan(
      complete.mock.invocationCallOrder[0],
    );
  });

  it("a reset for a different chat is NOT blocked by an in-flight turn", async () => {
    const { complete, reached, release } = gatedTransport();
    const { agent, chatStore } = await setupAgent(complete);
    const resetSpy = vi.spyOn(chatStore, "resetConversation");

    const turn = agent.chat("c1", "hello");
    await reached;
    expect(complete).toHaveBeenCalledTimes(1);

    await expect(agent.resetSession("c2")).resolves.toEqual({ memoryFlushed: true });
    expect(resetSpy).toHaveBeenCalledWith({
      chatId: "c2",
      boundaryAt: "1970-01-01T00:00:00.000Z",
      reason: "explicit-reset",
    });

    release();
    await turn;
  });

  it("resetSession's return value survives the lock wrap", async () => {
    const complete = vi.fn(async () => mkAssistant("ok"));
    const { agent } = await setupAgent(complete);
    await expect(agent.resetSession("c3")).resolves.toEqual({ memoryFlushed: true });
  });

  it("propagates an explicit reset failure without generation or completed-turn delivery", async () => {
    const complete = vi.fn(async () => mkAssistant("must not run"));
    const { agent, chatStore } = await setupAgent(complete);
    const failure = new Error("synthetic reset failure");
    const resetSpy = vi.spyOn(chatStore, "resetConversation").mockImplementation(() => {
      throw failure;
    });

    await expect(agent.resetSession("explicit-failure")).rejects.toBe(failure);
    expect(resetSpy).toHaveBeenCalledTimes(1);
    expect(complete).not.toHaveBeenCalled();
  });

  it("stops a stale turn before generation, transcript capture, or final text when reset fails", async () => {
    const complete = vi.fn(async () => mkAssistant("must not run"));
    const { agent, chatStore, transcriptWriter } = await setupAgent(complete);
    const failure = new Error("synthetic stale reset failure");
    vi.spyOn(chatStore, "load").mockReturnValue({
      messages: [],
      lastMessageTime: "1969-12-31T00:00:00.000Z",
    });
    const resetSpy = vi.spyOn(chatStore, "resetConversation").mockImplementation(() => {
      throw failure;
    });
    const completedSpy = vi.spyOn(transcriptWriter, "appendCompletedTurn");
    const events: TurnEvent[] = [];

    await expect(
      agent.chat("stale-failure", "hello", undefined, (event) => events.push(event)),
    ).rejects.toBe(failure);
    expect(resetSpy).toHaveBeenCalledTimes(1);
    expect(complete).not.toHaveBeenCalled();
    expect(completedSpy).not.toHaveBeenCalled();
    expect(events.some((event) => event.type === "final-text")).toBe(false);
  });
});
