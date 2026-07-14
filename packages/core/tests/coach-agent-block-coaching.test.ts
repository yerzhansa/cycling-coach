import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baseAgentConfig } from "./helpers/base-agent-config.js";
import { cyclingSport } from "@enduragent/sport-cycling";
import type { Sport } from "../src/sport.js";
import {
  SYSTEM_PROMPT_CACHE_BOUNDARY,
} from "../src/agent/system-prompt.js";

let tempHome: string;
let origHome: string | undefined;
let dataDir: string;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "cc-blockcoaching-"));
  origHome = process.env.HOME;
  process.env.HOME = tempHome;
  dataDir = join(tempHome, ".cycling-coach");
  mkdirSync(join(dataDir, "memory"), { recursive: true });
  mkdirSync(join(dataDir, "data"), { recursive: true });
  vi.resetModules();
});

afterEach(() => {
  process.env.HOME = origHome;
  rmSync(tempHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const FLUSH_MARKER = "reviewing a conversation to extract and save important athlete";
const DISCLOSE_MARKER = "won't base numbers on it";

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

/** Capture the main-turn system prompt (the one that is NOT the flush/summary call). */
function captureMainPrompt() {
  const seen: string[] = [];
  const complete = vi.fn(async (params: { system?: string }) => {
    const sys = params.system ?? "";
    if (sys.includes(FLUSH_MARKER)) return mkAssistant("facts noted");
    if (sys.length === 0) return mkAssistant("summary");
    seen.push(sys);
    return mkAssistant("all good");
  });
  return { complete, seen };
}

function writeErrorStateFile(mitigation: string | undefined): void {
  const payload: Record<string, unknown> = {
    schema_version: "1",
    step: "gate_rejected",
    detail: "step1_ftp_source: FTP source missing",
    ts: "2026-05-09T14:00:00.000Z",
  };
  if (mitigation !== undefined) payload.mitigation = mitigation;
  writeFileSync(join(dataDir, "data", "error_state.json"), JSON.stringify(payload));
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
  return new CoachAgent(cyclingSport as unknown as Sport, baseAgentConfig(dataDir));
}

describe("block_coaching consume side (degrade-and-disclose prompt block)", () => {
  it("block_coaching on disk ⇒ a degrade-and-disclose block in the volatile prompt tail", async () => {
    writeErrorStateFile("block_coaching");
    const { complete, seen } = captureMainPrompt();
    const agent = await setupAgent(complete);

    const text = await agent.chat("blk-chat", "how's my training?");
    expect(text).toBe("all good");

    const prompt = seen.at(-1) ?? "";
    expect(prompt).toContain(DISCLOSE_MARKER);
    // The block renders AFTER the cache boundary (volatile tail), not in the prefix.
    const boundaryIdx = prompt.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY.replace(/^\n\n---\n\n/, ""));
    const blockIdx = prompt.indexOf(DISCLOSE_MARKER);
    expect(boundaryIdx).toBeGreaterThanOrEqual(0);
    expect(blockIdx).toBeGreaterThan(boundaryIdx);
  });

  it("no error_state.json ⇒ no degrade block; coach answers normally", async () => {
    const { complete, seen } = captureMainPrompt();
    const agent = await setupAgent(complete);

    const text = await agent.chat("clean-chat", "how's my training?");
    expect(text).toBe("all good");
    expect(seen.at(-1) ?? "").not.toContain(DISCLOSE_MARKER);
  });

  it("warn_only ⇒ no degrade block (only block_coaching triggers it)", async () => {
    writeErrorStateFile("warn_only");
    const { complete, seen } = captureMainPrompt();
    const agent = await setupAgent(complete);

    const text = await agent.chat("warn-chat", "how's my training?");
    expect(text).toBe("all good");
    expect(seen.at(-1) ?? "").not.toContain(DISCLOSE_MARKER);
  });

  it("unreadable / garbage error_state.json ⇒ no block, no throw (fail-open on the read)", async () => {
    writeFileSync(join(dataDir, "data", "error_state.json"), "{ not valid json ::");
    const { complete, seen } = captureMainPrompt();
    const agent = await setupAgent(complete);

    // Required-red: a read that throws on bad JSON instead of safeReadJson breaks this.
    const text = await agent.chat("garbage-chat", "how's my training?");
    expect(text).toBe("all good");
    expect(seen.at(-1) ?? "").not.toContain(DISCLOSE_MARKER);
  });
});
