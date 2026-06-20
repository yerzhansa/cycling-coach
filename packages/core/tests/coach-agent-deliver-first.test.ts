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

function errored(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: append failed`), { code });
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

  const { CoachAgent, __resetPersistenceNoticeState } = await import("../src/agent/coach-agent.js");
  const { ChatStore } = await import("../src/agent/chat-store.js");
  const agent = new CoachAgent(cyclingSport as unknown as Sport, baseAgentConfig(dataDir));
  return { agent, ChatStore, __resetPersistenceNoticeState };
}

function happyComplete(reply: string) {
  return vi.fn(async (_model: unknown, context: { systemPrompt?: string }) => {
    const sys = context.systemPrompt ?? "";
    if (sys.includes(FLUSH_MARKER)) return mkAssistant("facts noted");
    if (sys.length === 0) return mkAssistant("summary");
    return mkAssistant(reply);
  });
}

function sessionFile(chatId: string): string {
  return join(dataDir, "sessions", `${chatId}.jsonl`);
}

const DISK_FULL_FRAGMENT = "disk is full";

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
    vi.spyOn(ChatStore.prototype, "appendTurn").mockImplementation(() => {
      throw errored("ENOSPC");
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const first = await agent.chat("disk-chat", "hello");
    expect(first).toContain("here is your reply");
    expect(first).toContain(DISK_FULL_FRAGMENT);

    const second = await agent.chat("disk-chat", "again");
    expect(second).toContain("here is your reply");
    expect(second).not.toContain(DISK_FULL_FRAGMENT);
  });

  it("delivers the reply on a non-ENOSPC append with no athlete note", async () => {
    const { agent, ChatStore, __resetPersistenceNoticeState } = await setupAgent(
      happyComplete("eacces reply"),
    );
    resetNotice = __resetPersistenceNoticeState;
    resetNotice();
    vi.spyOn(ChatStore.prototype, "appendTurn").mockImplementation(() => {
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
      .filter((l) => l.length > 0);
    expect(lines.some((l) => l.includes('"role":"user"'))).toBe(true);
    expect(lines.some((l) => l.includes('"role":"assistant"'))).toBe(true);
  });
});
