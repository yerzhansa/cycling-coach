import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
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
  tempHome = mkdtempSync(join(tmpdir(), "cc-deliver-first-"));
  origHome = process.env.HOME;
  process.env.HOME = tempHome;
  dataDir = join(tempHome, ".cycling-coach");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(dataDir, "memory"), { recursive: true });
  vi.resetModules();
});

const FLUSH_MARKER = "reviewing a conversation to extract and save important athlete";

function mkAssistant(text: string) {
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
    stopReason: "stop" as const,
  };
}

function errored(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: append failed`), { code });
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

  const { CoachAgent, __resetPersistenceNoticeState } = await import("../src/agent/coach-agent.js");
  const { ChatStore } = await import("../src/agent/chat-store.js");
  const agent = new CoachAgent(cyclingSport as unknown as Sport, baseAgentConfig(dataDir));
  return { agent, ChatStore, __resetPersistenceNoticeState };
}

function happyComplete(reply: string) {
  return vi.fn(async (params: { system?: string }) => {
    const sys = params.system ?? "";
    if (sys.includes(FLUSH_MARKER)) return mkAssistant("facts noted");
    if (sys.length === 0) return mkAssistant("summary");
    return mkAssistant(reply);
  });
}

function sessionFile(chatId: string): string {
  return join(dataDir, "sessions", `${chatId}.jsonl`);
}

const DISK_FULL_FRAGMENT = "disk is full";
const DISK_FULL_NOTE =
  "\n\n(Heads up: my disk is full, so I couldn't save this to our history — but your message went through. Please free up some space when you can.)";

describe("coach-agent deliver-first persistence", () => {
  let resetNotice: () => void;

  afterEach(() => {
    resetNotice?.();
    process.env.HOME = origHome;
    rmSync(tempHome, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("delivers the reply on an ENOSPC append and appends the disk-full note only once", async () => {
    const { agent, ChatStore, __resetPersistenceNoticeState } = await setupAgent(
      happyComplete("here is your reply"),
    );
    resetNotice = __resetPersistenceNoticeState;
    resetNotice();
    // The user line is appended before generation and the assistant line after;
    // both go through appendMessage now. Throwing on it exercises deliver-first
    // on the reply-persist path (the disk-full note rides the assistant append).
    const appendSpy = vi.spyOn(ChatStore.prototype, "appendMessage").mockImplementation(() => {
      throw errored("ENOSPC");
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const first = await agent.chat("disk-chat", "hello");
    expect(first).toBe("here is your reply" + DISK_FULL_NOTE);

    const second = await agent.chat("disk-chat", "again");
    expect(second).toBe("here is your reply");
    const attemptedAssistantCores = appendSpy.mock.calls
      .filter((call) => call[1] === "assistant")
      .map((call) => call[2]);
    expect(attemptedAssistantCores).toEqual([
      "here is your reply",
      "here is your reply",
    ]);
    expect(attemptedAssistantCores.every((core) => !core.includes(DISK_FULL_FRAGMENT))).toBe(true);
  });

  it("delivers the reply on a non-ENOSPC append with no athlete note", async () => {
    const { agent, ChatStore, __resetPersistenceNoticeState } = await setupAgent(
      happyComplete("eacces reply"),
    );
    resetNotice = __resetPersistenceNoticeState;
    resetNotice();
    vi.spyOn(ChatStore.prototype, "appendMessage").mockImplementation(() => {
      throw errored("EACCES");
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const text = await agent.chat("eacces-chat", "hello");
    expect(text).toBe("eacces reply");
    expect(text).not.toContain(DISK_FULL_FRAGMENT);
  });

  it("happy path returns the reply with no note and persists the turn", async () => {
    const { agent, __resetPersistenceNoticeState } = await setupAgent(
      happyComplete("persisted reply"),
    );
    resetNotice = __resetPersistenceNoticeState;
    resetNotice();

    const text = await agent.chat("happy-chat", "hello");
    expect(text).toBe("persisted reply");
    expect(text).not.toContain(DISK_FULL_FRAGMENT);

    expect(existsSync(sessionFile("happy-chat"))).toBe(true);
    const lines = readFileSync(sessionFile("happy-chat"), "utf-8")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((line) => JSON.parse(line) as { role: string; content: string });
    expect(lines.some((line) => line.role === "user")).toBe(true);
    expect(lines.filter((line) => line.role === "assistant").map((line) => line.content)).toEqual([
      "persisted reply",
    ]);
  });

  it("leaves the athlete message and a failure marker in history when the turn throws", async () => {
    const complete = vi.fn(async (params: { system?: string }) => {
      const sys = params.system ?? "";
      if (sys.includes(FLUSH_MARKER)) return mkAssistant("facts noted");
      if (sys.length === 0) return mkAssistant("summary");
      throw new Error("provider exploded");
    });
    const { agent, __resetPersistenceNoticeState } = await setupAgent(complete);
    resetNotice = __resetPersistenceNoticeState;
    resetNotice();
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(agent.chat("fail-chat", "remember I hate hills")).rejects.toThrow();

    const lines = readFileSync(sessionFile("fail-chat"), "utf-8")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { role: string; content: string });
    expect(lines.some((l) => l.role === "user" && l.content === "remember I hate hills")).toBe(true);
    expect(lines.some((l) => l.role === "system" && l.content.includes("did not complete"))).toBe(true);
  });

  it("prefixes the post-reset notice and shows the model a one-turn archive marker", async () => {
    const POST_RESET_NOTICE =
      "Started a fresh session - earlier conversation is archived, and I still have your key details in memory.";
    const complete = happyComplete("here is the answer");
    const { agent, __resetPersistenceNoticeState } = await setupAgent(complete);
    resetNotice = __resetPersistenceNoticeState;
    resetNotice();
    vi.spyOn(console, "warn").mockImplementation(() => {});

    // Seed a session last touched long before today's daily reset hour so the
    // automatic daily reset fires (and is NOT deferred).
    const oldTs = "1998-01-01T00:00:00.000Z";
    writeFileSync(
      sessionFile("reset-chat"),
      JSON.stringify({ role: "user", content: "old q", ts: oldTs }) +
        "\n" +
        JSON.stringify({ role: "assistant", content: "old a", ts: oldTs }) +
        "\n",
      "utf-8",
    );

    const reply = await agent.chat("reset-chat", "how's my form?");

    expect(reply).toBe(
      `${POST_RESET_NOTICE}\n\n${"here is the answer"}`,
    );

    const sawMarker = complete.mock.calls.some((call) => {
      const params = call[0] as { messages?: Array<{ role: string; content: unknown }> };
      return (
        Array.isArray(params.messages) &&
        params.messages.some(
          (m) =>
            m.role === "system" &&
            typeof m.content === "string" &&
            m.content.includes("Previous session archived at"),
        )
      );
    });
    expect(sawMarker).toBe(true);

    // The prior transcript was archived (renamed away).
    const currentSession = readFileSync(sessionFile("reset-chat"), "utf-8");
    expect(currentSession).not.toContain("old q");
    const currentLines = currentSession
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as { role: string; content: string });
    expect(
      currentLines.filter((line) => line.role === "assistant").map((line) => line.content),
    ).toEqual(["here is the answer"]);
    expect(currentSession).not.toContain(POST_RESET_NOTICE);
  });
});
