import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";
import { SecretRef, isSecretRef, SecretResolutionError } from "./secrets/types.js";
import { resolveSecretRef } from "./secrets/resolve.js";

// ============================================================================
// TYPES
// ============================================================================

export interface Config {
  llm: {
    provider: "anthropic" | "openai" | "google" | "openai-codex";
    model: string;
    apiKey: string;
    authProfile?: string;
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
    /** Athlete IANA timezone (e.g. "Europe/Berlin"). Empty = resolver picks host TZ. */
    timezone: string;
  };
  contextWindowTokens: number;
  dataDir: string;
}

// ============================================================================
// CONFIG LOADING
// ============================================================================

function resolveConfigDir(): string {
  const override = process.env.CYCLING_COACH_HOME;
  if (override && override.length > 0) {
    if (override === "~" || override.startsWith("~/")) {
      return join(homedir(), override.slice(1));
    }
    return override;
  }
  return join(homedir(), ".cycling-coach");
}

export const CONFIG_DIR = resolveConfigDir();
export const CONFIG_FILE = join(CONFIG_DIR, "config.yaml");

export function readConfigYaml(): Record<string, unknown> {
  if (!existsSync(CONFIG_FILE)) return {};
  const raw = readFileSync(CONFIG_FILE, "utf-8");
  try {
    return (parseYaml(raw) as Record<string, unknown>) ?? {};
  } catch {
    return {};
  }
}

// ============================================================================
// CONTEXT WINDOW RESOLUTION
// ============================================================================

const CONTEXT_WINDOWS: Record<string, number> = {
  "claude-sonnet-4-6": 1_000_000,
  "claude-haiku-4-5-20251001": 200_000,
  "gpt-4o": 128_000,
  "gemini-2.0-flash": 1_000_000,
  "gpt-5.4": 272_000,
  "gpt-5.4-mini": 272_000,
  "gpt-5.4-pro": 272_000,
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

// ============================================================================
// SECRET REF HANDLING
// ============================================================================

type SecretFieldPath = "llm.api_key" | "intervals.api_key" | "telegram.bot_token";

const PENDING_REFS = new WeakMap<Config, Map<SecretFieldPath, SecretRef>>();

function readSecretField(value: unknown, path: SecretFieldPath): string | SecretRef | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  if (isSecretRef(value)) return value;
  throw new SecretResolutionError(
    "INVALID_REF",
    `Config field ${path} is not a valid SecretRef. Expected a string, { source: "exec", command: string, args?: string[] }, or { source: "env", var: string }.`,
  );
}

function assignFieldByPath(cfg: Config, path: SecretFieldPath, value: string): void {
  if (path === "llm.api_key") cfg.llm.apiKey = value;
  else if (path === "intervals.api_key") cfg.intervals.apiKey = value;
  else if (path === "telegram.bot_token") cfg.telegram.botToken = value;
}

export function loadConfig(): Config {
  const yaml = readConfigYaml();
  const llmYaml = (yaml.llm as Record<string, unknown>) ?? {};
  const intervalsYaml = (yaml.intervals as Record<string, unknown>) ?? {};
  const telegramYaml = (yaml.telegram as Record<string, unknown>) ?? {};
  const sessionYaml = (yaml.session as Record<string, unknown>) ?? {};

  const provider = (env("LLM_PROVIDER") ??
    (llmYaml.provider as string | undefined) ??
    "anthropic") as Config["llm"]["provider"];

  const llmApiKeyRaw = readSecretField(llmYaml.api_key, "llm.api_key");
  const intervalsApiKeyRaw = readSecretField(intervalsYaml.api_key, "intervals.api_key");
  const telegramTokenRaw = readSecretField(telegramYaml.bot_token, "telegram.bot_token");

  const envKeyForProvider: Record<string, string | undefined> = {
    anthropic: "ANTHROPIC_API_KEY",
    openai: "OPENAI_API_KEY",
    google: "GOOGLE_GENERATIVE_AI_API_KEY",
    "openai-codex": undefined,
  };

  const pending = new Map<SecretFieldPath, SecretRef>();

  const resolveWithPrecedence = (
    envVar: string | undefined,
    raw: string | SecretRef | undefined,
    path: SecretFieldPath,
  ): string => {
    const envValue = envVar !== undefined ? env(envVar) : undefined;
    if (envValue !== undefined && envValue !== "") {
      if (raw !== undefined && typeof raw !== "string") {
        console.log(`Using env ${envVar}; SecretRef for ${path} skipped.`);
      }
      return envValue;
    }
    if (typeof raw === "string") return raw;
    if (raw !== undefined) {
      pending.set(path, raw);
      return "";
    }
    return "";
  };

  const apiKey =
    provider === "openai-codex"
      ? ""
      : resolveWithPrecedence(envKeyForProvider[provider], llmApiKeyRaw, "llm.api_key");
  const intervalsApiKey = resolveWithPrecedence(
    "INTERVALS_API_KEY",
    intervalsApiKeyRaw,
    "intervals.api_key",
  );
  const telegramBotToken = resolveWithPrecedence(
    "TELEGRAM_BOT_TOKEN",
    telegramTokenRaw,
    "telegram.bot_token",
  );

  const defaultModelMap: Record<string, string> = {
    anthropic: "claude-sonnet-4-6",
    openai: "gpt-4o",
    google: "gemini-2.0-flash",
    "openai-codex": "gpt-5.4",
  };

  const model =
    env("LLM_MODEL") ?? (llmYaml.model as string | undefined) ?? defaultModelMap[provider];

  const config: Config = {
    llm: {
      provider,
      model,
      apiKey,
      authProfile:
        provider === "openai-codex"
          ? ((llmYaml.auth_profile as string | undefined) ?? "openai-codex")
          : undefined,
    },
    intervals: {
      apiKey: intervalsApiKey,
      athleteId:
        env("INTERVALS_ATHLETE_ID") ??
        (intervalsYaml.athlete_id as string | undefined) ??
        "0",
    },
    telegram: {
      botToken: telegramBotToken,
    },
    session: {
      historyTokenBudgetRatio:
        envFloat("HISTORY_TOKEN_BUDGET_RATIO") ??
        (sessionYaml.historyTokenBudgetRatio as number) ??
        0.3,
      idleMinutes:
        envInt("SESSION_IDLE_MINUTES") ?? (sessionYaml.idleMinutes as number) ?? 0,
      dailyResetHour:
        envInt("SESSION_DAILY_RESET_HOUR") ?? (sessionYaml.dailyResetHour as number) ?? 4,
      timezone:
        env("COACH_TZ") ?? (sessionYaml.timezone as string | undefined) ?? "",
    },
    contextWindowTokens: resolveContextWindowTokens(model),
    dataDir: (yaml.data_dir as string) ?? CONFIG_DIR,
  };

  if (pending.size > 0) {
    PENDING_REFS.set(config, pending);
  }

  return config;
}

export async function resolveConfigSecrets(cfg: Config): Promise<Config> {
  const pending = PENDING_REFS.get(cfg);
  if (!pending || pending.size === 0) return cfg;

  const next: Config = {
    ...cfg,
    llm: { ...cfg.llm },
    intervals: { ...cfg.intervals },
    telegram: { ...cfg.telegram },
    session: { ...cfg.session },
  };

  for (const [path, ref] of pending) {
    const value = await resolveSecretRef(ref);
    assignFieldByPath(next, path, value);
    const desc = ref.source === "env" ? `env: ${ref.var}` : `exec: ${ref.command}`;
    console.log(`Resolved secret: ${path} (${desc})`);
  }

  return next;
}
