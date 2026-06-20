import { beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
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
  "CONTEXT_WINDOW_TOKENS",
  "SESSION_RESET_ARCHIVE_RETENTION_DAYS",
];

/**
 * Registers beforeEach/afterEach hooks that point HOME at a fresh temp dir
 * (with `.cycling-coach/` created), clear `CYCLING_COACH_HOME` and every
 * managed env var, and restore everything afterward. Returns a getter for
 * the current temp HOME.
 */
export function setupConfigEnvSandbox(prefix: string): () => string {
  let tempHome: string;
  let origHome: string | undefined;
  let origCcHome: string | undefined;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), prefix));
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

  return () => tempHome;
}
