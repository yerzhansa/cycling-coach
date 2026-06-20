import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MANAGED_ENV = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "DEEPSEEK_API_KEY",
  "ALIBABA_API_KEY",
  "MINIMAX_API_KEY",
  "MOONSHOT_API_KEY",
  "ZAI_API_KEY",
  "OPENROUTER_API_KEY",
  "LLM_BASE_URL",
  "INTERVALS_API_KEY",
  "INTERVALS_ATHLETE_ID",
  "TELEGRAM_BOT_TOKEN",
  "LLM_PROVIDER",
  "LLM_MODEL",
  "LLM_FLUSH_MODEL",
  "CONTEXT_WINDOW_TOKENS",
];

let tempHome: string;
let origHome: string | undefined;
let origCcHome: string | undefined;
const savedEnv: Record<string, string | undefined> = {};

function writeYaml(body: string): void {
  writeFileSync(join(tempHome, ".cycling-coach", "config.yaml"), body, "utf-8");
}

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "cc-flushmodel-"));
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

describe("config — flush-model resolution", () => {
  it("env LLM_FLUSH_MODEL resolves into cfg.llm.flushModel", async () => {
    process.env.LLM_PROVIDER = "anthropic";
    process.env.LLM_FLUSH_MODEL = "claude-haiku-4-5-20251001";
    const { loadConfig } = await import("../src/config.js");
    expect(loadConfig().llm.flushModel).toBe("claude-haiku-4-5-20251001");
  });

  it("YAML llm.flush_model resolves when the env var is unset", async () => {
    writeYaml("llm:\n  provider: anthropic\n  flush_model: claude-haiku-4-5-20251001\n");
    const { loadConfig } = await import("../src/config.js");
    expect(loadConfig().llm.flushModel).toBe("claude-haiku-4-5-20251001");
  });

  it("env beats YAML", async () => {
    writeYaml("llm:\n  provider: anthropic\n  flush_model: yaml-model\n");
    process.env.LLM_FLUSH_MODEL = "env-model";
    const { loadConfig } = await import("../src/config.js");
    expect(loadConfig().llm.flushModel).toBe("env-model");
  });

  it("unset resolves to undefined (the no-change fallback)", async () => {
    process.env.LLM_PROVIDER = "anthropic";
    const { loadConfig } = await import("../src/config.js");
    expect(loadConfig().llm.flushModel).toBeUndefined();
  });
});
