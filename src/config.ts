import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";

// ============================================================================
// TYPES
// ============================================================================

export interface Config {
  llm: {
    provider: "anthropic" | "openai" | "google";
    model: string;
    apiKey: string;
  };
  intervals: {
    apiKey: string;
    athleteId: string;
  };
  telegram: {
    botToken: string;
  };
  session: {
    historyTokenBudgetRatio: number;
    idleMinutes: number;
    dailyResetHour: number;
  };
  contextWindowTokens: number;
  dataDir: string;
}

// ============================================================================
// CONFIG LOADING
// ============================================================================

export const CONFIG_DIR = join(homedir(), ".cycling-coach");
export const CONFIG_FILE = join(CONFIG_DIR, "config.yaml");

function loadYamlConfig(): Record<string, unknown> {
  if (!existsSync(CONFIG_FILE)) return {};
  const raw = readFileSync(CONFIG_FILE, "utf-8");
  return (parseYaml(raw) as Record<string, unknown>) ?? {};
}

// ============================================================================
// CONTEXT WINDOW RESOLUTION
// ============================================================================

const CONTEXT_WINDOWS: Record<string, number> = {
  "claude-haiku-4-5-20251001": 200_000,
  "claude-sonnet-4-5-20241022": 200_000,
  "gpt-4o": 128_000,
  "gemini-2.0-flash": 1_000_000,
};

function resolveContextWindowTokens(model: string): number {
  const envTokens = parseInt(process.env.CONTEXT_WINDOW_TOKENS ?? "", 10);
  if (envTokens > 0) return envTokens;

  const known = CONTEXT_WINDOWS[model];
  if (known) return known;

  return 200_000;
}

// ============================================================================
// CONFIG LOADING
// ============================================================================

function env(key: string): string | undefined {
  return process.env[key];
}

function envInt(key: string): number | undefined {
  const v = process.env[key];
  if (v === undefined) return undefined;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

function envFloat(key: string): number | undefined {
  const v = process.env[key];
  if (v === undefined) return undefined;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : undefined;
}

export function loadConfig(): Config {
  const yaml = loadYamlConfig();
  const llmYaml = (yaml.llm as Record<string, string>) ?? {};
  const intervalsYaml = (yaml.intervals as Record<string, string>) ?? {};
  const telegramYaml = (yaml.telegram as Record<string, string>) ?? {};
  const sessionYaml = (yaml.session as Record<string, unknown>) ?? {};

  const provider = (env("LLM_PROVIDER") ??
    llmYaml.provider ??
    "anthropic") as Config["llm"]["provider"];

  const apiKeyMap: Record<string, string> = {
    anthropic: env("ANTHROPIC_API_KEY") ?? llmYaml.api_key ?? "",
    openai: env("OPENAI_API_KEY") ?? llmYaml.api_key ?? "",
    google: env("GOOGLE_GENERATIVE_AI_API_KEY") ?? llmYaml.api_key ?? "",
  };

  const defaultModelMap: Record<string, string> = {
    anthropic: "claude-sonnet-4-5-20241022",
    openai: "gpt-4o",
    google: "gemini-2.0-flash",
  };

  const model = env("LLM_MODEL") ?? llmYaml.model ?? defaultModelMap[provider];

  return {
    llm: {
      provider,
      model,
      apiKey: apiKeyMap[provider],
    },
    intervals: {
      apiKey: env("INTERVALS_API_KEY") ?? intervalsYaml.api_key ?? "",
      athleteId: env("INTERVALS_ATHLETE_ID") ?? intervalsYaml.athlete_id ?? "0",
    },
    telegram: {
      botToken: env("TELEGRAM_BOT_TOKEN") ?? telegramYaml.bot_token ?? "",
    },
    session: {
      historyTokenBudgetRatio: envFloat("HISTORY_TOKEN_BUDGET_RATIO") ?? (sessionYaml.historyTokenBudgetRatio as number) ?? 0.3,
      idleMinutes: envInt("SESSION_IDLE_MINUTES") ?? (sessionYaml.idleMinutes as number) ?? 0,
      dailyResetHour: envInt("SESSION_DAILY_RESET_HOUR") ?? (sessionYaml.dailyResetHour as number) ?? 4,
    },
    contextWindowTokens: resolveContextWindowTokens(model),
    dataDir: (yaml.data_dir as string) ?? CONFIG_DIR,
  };
}
