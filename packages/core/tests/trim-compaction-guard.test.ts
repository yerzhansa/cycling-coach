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
  tempHome = mkdtempSync(join(tmpdir(), "cc-trimguard-"));
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
  return new CoachAgent(cyclingSport as unknown as Sport, {
    ...baseAgentConfig(dataDir),
    contextWindowTokens: 120_000,
  });
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

function seedSession(chatId: string, lines: Array<{ role: string; content: string; ts: string }>) {
  const sessionsDir = join(dataDir, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(
    join(sessionsDir, `${chatId}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
    "utf-8",
  );
}

function listPrecompact(chatId: string): string[] {
  return readdirSync(join(dataDir, "sessions")).filter((f) =>
    f.startsWith(`${chatId}.jsonl.precompact.`),
  );
}

const FIVE_SECTION_SUMMARY = [
  "## Athlete Profile",
  "- FTP 247W, 72kg",
  "## Training Status",
  "- Build phase",
  "## Coach Stance",
  "- Hold volume this week",
  "## Discussion Context",
  "- Goal review",
  "## Pending Questions",
  "- None outstanding",
].join("\n");

const FRESH_TS = new Date().toISOString();
const seeded = Array.from({ length: 30 }, (_, i) => ({
  role: i % 2 === 0 ? "user" : "assistant",
  content: `TRIM-MARK-${i} ` + "x".repeat(2_400),
  ts: FRESH_TS,
}));

describe("trim-path compaction guard", () => {
  it("flushes, archives, then overwrites on a successful trim", async () => {
    let n = 0;
    const complete = vi.fn(async () => {
      n++;
      if (n === 1) return mkAssistant("facts noted");
      if (n === 2) return mkAssistant(FIVE_SECTION_SUMMARY);
      return mkAssistant("final-reply");
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const agent = await setupAgent(complete);
    seedSession("trim-ok", seeded);

    const text = await agent.chat("trim-ok", "hello");

    expect(text).toBe("final-reply");
    expect(complete).toHaveBeenCalledTimes(3);

    const archives = listPrecompact("trim-ok");
    expect(archives).toHaveLength(1);
    const archived = readFileSync(join(dataDir, "sessions", archives[0]), "utf-8");
    expect(archived).toContain("TRIM-MARK-0");
    expect(archived).toContain("TRIM-MARK-29");

    const session = readFileSync(join(dataDir, "sessions", "trim-ok.jsonl"), "utf-8");
    expect(session).toContain("## Coach Stance");
    expect(session).toContain("TRIM-MARK-29");
    expect(session).toContain("hello");
    expect(session).toContain("final-reply");
    expect(session).not.toContain("TRIM-MARK-0 ");

    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes("flush failed"))).toBe(false);
  });

  it("skips archive and overwrite when the flush fails; the turn still completes", async () => {
    let n = 0;
    const complete = vi.fn(async () => {
      n++;
      if (n <= 2) throw new Error("boom");
      if (n === 3) return mkAssistant(FIVE_SECTION_SUMMARY);
      return mkAssistant("final-reply");
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const agent = await setupAgent(complete);
    seedSession("trim-flush-fail", seeded);

    const text = await agent.chat("trim-flush-fail", "hello");

    expect(text).toBe("final-reply");
    expect(complete).toHaveBeenCalledTimes(4);
    expect(listPrecompact("trim-flush-fail")).toHaveLength(0);

    const session = readFileSync(join(dataDir, "sessions", "trim-flush-fail.jsonl"), "utf-8");
    expect(session).toContain("TRIM-MARK-0 ");
    expect(session).not.toContain("## Coach Stance");

    expect(
      warnSpy.mock.calls.some((c) => String(c[0]).includes("Pre-compaction memory flush failed")),
    ).toBe(true);
  });

  it("leaves history untouched when summarization fails entirely", async () => {
    let n = 0;
    const complete = vi.fn(async () => {
      n++;
      if (n === 1) return mkAssistant("facts noted");
      if (n === 2) throw new Error("boom");
      return mkAssistant("final-reply");
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const agent = await setupAgent(complete);
    seedSession("trim-summary-fail", seeded);

    const text = await agent.chat("trim-summary-fail", "hello");

    expect(text).toBe("final-reply");
    expect(listPrecompact("trim-summary-fail")).toHaveLength(0);

    const session = readFileSync(join(dataDir, "sessions", "trim-summary-fail.jsonl"), "utf-8");
    expect(session).toContain("TRIM-MARK-0 ");
    expect(session).not.toContain("## Coach Stance");

    expect(
      warnSpy.mock.calls.some((c) => String(c[0]).includes("Dropped message summarization failed")),
    ).toBe(true);
  });
});
