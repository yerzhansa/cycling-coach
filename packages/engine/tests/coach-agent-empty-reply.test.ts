import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baseAgentConfig } from "./helpers/base-agent-config.js";
import { cyclingSport } from "@enduragent/sport-cycling";
import type { Sport } from "../src/sport.js";

let tempHome: string;
let origHome: string | undefined;
let dataDir: string;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "cc-empty-reply-"));
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
const GENERIC_APOLOGY = "Sorry, something went wrong. Please try again.";

function mkAssistant(text: string, stopReason: "stop" | "toolUse" = "stop") {
  return {
    text,
    toolCalls: [] as Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    stopReason,
  };
}

function exhaustedTurn() {
  return {
    ...mkAssistant("", "toolUse"),
    toolCalls: [{ id: "call-1|item-1", name: "synthetic_probe", arguments: {} }],
  };
}

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
  const agent = new CoachAgent(cyclingSport as unknown as Sport, baseAgentConfig(dataDir));
  return { agent };
}

function sessionFile(chatId: string): string {
  return join(dataDir, "sessions", `${chatId}.jsonl`);
}

function assistantLines(chatId: string): Array<{ role: string; content: string }> {
  if (!existsSync(sessionFile(chatId))) return [];
  return readFileSync(sessionFile(chatId), "utf-8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as { role: string; content: string })
    .filter((l) => l.role === "assistant");
}

// recoveryResult: how the no-tools recovery call (params.tools === undefined)
// behaves — returns the given result, or throws when it is the THROW sentinel.
const THROW = Symbol("throw");

function makeComplete(recoveryResult: ReturnType<typeof mkAssistant> | typeof THROW) {
  return vi.fn(async (params: { system?: string; tools?: unknown }) => {
    const sys = params.system ?? "";
    if (sys.includes(FLUSH_MARKER)) return mkAssistant("facts noted");
    if (sys.length === 0) return mkAssistant("summary");
    if (params.tools === undefined) {
      if (recoveryResult === THROW) throw new Error("recovery network error");
      return recoveryResult;
    }
    return exhaustedTurn();
  });
}

describe("coach-agent empty-reply guards", () => {
  it("returns the static truncation floor when the recovery completion is also empty", async () => {
    const { agent } = await setupAgent(makeComplete(mkAssistant("")));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const reply = await agent.chat("exhaust-chat", "deep review please");
    expect(reply).toContain("ran out of steps");
    expect(reply.trim()).not.toBe("");
  });

  it("returns the static truncation floor when the no-tools recovery throws", async () => {
    const { agent } = await setupAgent(makeComplete(THROW));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const reply = await agent.chat("exhaust-throw-chat", "deep review please");
    expect(reply).toContain("ran out of steps");
    expect(reply).not.toBe(GENERIC_APOLOGY);
    expect(reply.trim()).not.toBe("");
  });

  it("returns the recovery summary when the no-tools completion produces text", async () => {
    const { agent } = await setupAgent(
      makeComplete(mkAssistant("Pulled your last 4 weeks; still need your goal date.")),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const reply = await agent.chat("exhaust-recovered-chat", "deep review please");
    expect(reply).toContain("still need your goal date");
  });

  it("persists no empty assistant line after a step-exhausted turn", async () => {
    const { agent } = await setupAgent(makeComplete(mkAssistant("")));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const reply = await agent.chat("exhaust-persist-chat", "deep review please");
    const assistants = assistantLines("exhaust-persist-chat");
    expect(assistants.filter((l) => l.content.trim() === "")).toHaveLength(0);
    expect(assistants).toHaveLength(1);
    expect(assistants[0].content).toBe(reply);
  });

  it("leaves a normal non-exhausted turn unaffected", async () => {
    const complete = vi.fn(async (params: { system?: string }) => {
      const sys = params.system ?? "";
      if (sys.includes(FLUSH_MARKER)) return mkAssistant("facts noted");
      if (sys.length === 0) return mkAssistant("summary");
      return mkAssistant("Here is your plan.");
    });
    const { agent } = await setupAgent(complete);

    const reply = await agent.chat("normal-chat", "plan please");
    expect(reply).toBe("Here is your plan.");
    const assistants = assistantLines("normal-chat");
    expect(assistants).toHaveLength(1);
    expect(assistants[0].content).toBe("Here is your plan.");
  });
});
