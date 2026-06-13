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
  tempHome = mkdtempSync(join(tmpdir(), "cc-corrupt-recovery-"));
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

function seedRaw(chatId: string, content: string): void {
  const sessionsDir = join(dataDir, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(join(sessionsDir, `${chatId}.jsonl`), content, "utf-8");
}

function listArchives(chatId: string): string[] {
  return readdirSync(join(dataDir, "sessions")).filter((f) =>
    f.startsWith(`${chatId}.jsonl.reset.`),
  );
}

function listSidecars(chatId: string): string[] {
  return readdirSync(join(dataDir, "sessions")).filter((f) =>
    f.startsWith(`${chatId}.jsonl.corrupt.`),
  );
}

describe("CoachAgent corrupt-session recovery", () => {
  it("resetSession recovers a corrupt session: archive + sidecar, no throw", async () => {
    const complete = vi.fn(async () => mkAssistant("noted"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const agent = await setupAgent(complete);
    const valid = JSON.stringify({ role: "user", content: "we agreed: hold volume", ts: STALE_TS });
    seedRaw("corrupt-reset", `${valid}\n{"role":"assistant","content":"torn mid-wri`);

    await expect(agent.resetSession("corrupt-reset")).resolves.toBeUndefined();

    expect(complete).toHaveBeenCalledTimes(1);
    expect(agent.hasSession("corrupt-reset")).toBe(false);

    const archives = listArchives("corrupt-reset");
    expect(archives).toHaveLength(1);
    expect(readFileSync(join(dataDir, "sessions", archives[0]), "utf-8")).toContain("hold volume");

    const side = listSidecars("corrupt-reset");
    expect(side).toHaveLength(1);
    expect(readFileSync(join(dataDir, "sessions", side[0]), "utf-8")).toContain("torn mid-wri");
  });

  it("chat() continues over a corrupt fresh session", async () => {
    const complete = vi.fn(async () => mkAssistant("recovered-reply"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const agent = await setupAgent(complete);
    const fresh = JSON.stringify({ role: "user", content: "earlier turn", ts: new Date().toISOString() });
    seedRaw("corrupt-chat", `${fresh}\n{"role":"assistant","content":"torn mid-wri`);

    const text = await agent.chat("corrupt-chat", "hello");

    expect(text).toBe("recovered-reply");
    expect(complete).toHaveBeenCalledTimes(1);
    expect(listSidecars("corrupt-chat")).toHaveLength(1);

    const session = readFileSync(join(dataDir, "sessions", "corrupt-chat.jsonl"), "utf-8");
    expect(session).toContain("earlier turn");
    expect(session).toContain("hello");
    expect(session).toContain("recovered-reply");
    expect(session).not.toContain("torn mid-wri");
  });

  it("resetSession archives even when the session read itself fails (load guard)", async () => {
    const complete = vi.fn();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const agent = await setupAgent(complete);
    mkdirSync(join(dataDir, "sessions", "unreadable.jsonl"), { recursive: true });

    await expect(agent.resetSession("unreadable")).resolves.toBeUndefined();

    expect(
      warnSpy.mock.calls.some((c) => String(c[0]).includes("Pre-reset session load failed")),
    ).toBe(true);
    expect(complete).not.toHaveBeenCalled();
    expect(agent.hasSession("unreadable")).toBe(false);
  });
});
