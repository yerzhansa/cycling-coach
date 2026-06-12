import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MANAGED_ENV = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "INTERVALS_API_KEY",
  "INTERVALS_ATHLETE_ID",
  "TELEGRAM_BOT_TOKEN",
  "LLM_PROVIDER",
  "LLM_MODEL",
  "CONTEXT_WINDOW_TOKENS",
];

let tempHome: string;
let origHome: string | undefined;
let origCcHome: string | undefined;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "cc-defaultmodels-"));
  origHome = process.env.HOME;
  origCcHome = process.env.CYCLING_COACH_HOME;
  process.env.HOME = tempHome;
  delete process.env.CYCLING_COACH_HOME;
  mkdirSync(join(tempHome, ".cycling-coach"), { recursive: true });
  for (const k of MANAGED_ENV) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  vi.resetModules();
});

afterEach(() => {
  process.env.HOME = origHome;
  if (origCcHome !== undefined) process.env.CYCLING_COACH_HOME = origCcHome;
  else delete process.env.CYCLING_COACH_HOME;
  for (const k of MANAGED_ENV) {
    if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k];
    else delete process.env[k];
  }
  rmSync(tempHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("config — default model and context-window resolution", () => {
  it("google provider with no model defaults to gemini-2.5-flash with a 1M window", async () => {
    process.env.LLM_PROVIDER = "google";
    const { loadConfig } = await import("../src/config.js");
    const cfg = loadConfig();
    expect(cfg.llm.model).toBe("gemini-2.5-flash");
    expect(cfg.contextWindowTokens).toBe(1_000_000);
  });

  it("explicit gemini-2.5-flash model resolves the 1M window regardless of provider", async () => {
    process.env.LLM_PROVIDER = "anthropic";
    process.env.LLM_MODEL = "gemini-2.5-flash";
    const { loadConfig } = await import("../src/config.js");
    const cfg = loadConfig();
    expect(cfg.contextWindowTokens).toBe(1_000_000);
  });

  it("openai provider with no model stays pinned to gpt-4o with a 128k window", async () => {
    process.env.LLM_PROVIDER = "openai";
    const { loadConfig } = await import("../src/config.js");
    const cfg = loadConfig();
    expect(cfg.llm.model).toBe("gpt-4o");
    expect(cfg.contextWindowTokens).toBe(128_000);
  });
});
