import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { getCoachHome } from "./coach-home.js";
import { SecretRef, isSecretRef, SecretResolutionError } from "./secrets/types.js";
import { resolveSecretRef } from "./secrets/resolve.js";

// ============================================================================
// TYPES
// ============================================================================

export interface Config {
  llm: {
    provider:
      | "anthropic"
      | "openai"
      | "google"
      | "openai-codex"
      | "deepseek"
      | "qwen"
      | "minimax"
      | "kimi"
      | "zai"
      | "openrouter";
    model: string;
    apiKey: string;
    authProfile?: string;
    /** Cheaper model for the memory flush; unset reuses the chat model. */
    flushModel?: string;
    /** Override base URL for OpenAI-compatible / direct providers. Empty = provider default. */
    baseUrl?: string;
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
    /** Days to keep session reset archives; 0 = keep forever (pruning disabled). */
    resetArchiveRetentionDays: number;
    /** Athlete IANA timezone (e.g. "Europe/Berlin"). Empty = resolver picks host TZ. */
    timezone: string;
  };
  contextWindowTokens: number;
  dataDir: string;
}

// ============================================================================
// CONFIG LOADING
// ============================================================================

export const CONFIG_DIR = getCoachHome("cycling-coach");
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
  "gemini-2.5-flash": 1_000_000,
  "gpt-5.4": 272_000,
  "gpt-5.4-mini": 272_000,
  "gpt-5.4-pro": 272_000,
  "deepseek-v4-flash": 128_000,
  "deepseek-v4-pro": 128_000,
  "qwen-plus": 131_072,
  "qwen3-max": 262_144,
  "MiniMax-M2-Stable": 200_000,
  "kimi-k2-0905": 256_000,
  "glm-4.6": 200_000,
  "glm-4.5": 128_000,
  "deepseek/deepseek-chat": 128_000,
};

// Per-provider default API host. OpenAI-compatible providers (minimax/kimi/zai)
// REQUIRE a base URL; the direct providers and OpenRouter ship a package default
// but accept an override for proxies / mainland endpoints. The built-in four
// (anthropic/openai/google/openai-codex) have no entry, so their base URL stays
// undefined unless the operator sets one. Single source of truth: loadConfig
// resolves it, the setup wizard prompts with it, and llm.ts uses it as the
// required-baseURL fallback for the OpenAI-compatible providers.
export const PROVIDER_BASE_URLS: Record<string, string> = {
  deepseek: "https://api.deepseek.com/v1",
  qwen: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
  minimax: "https://api.minimax.io/v1",
  kimi: "https://api.moonshot.ai/v1",
  zai: "https://api.z.ai/api/openai/v1",
  openrouter: "https://openrouter.ai/api/v1",
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

export function envInt(key: string): number | undefined {
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
    deepseek: "DEEPSEEK_API_KEY",
    qwen: "ALIBABA_API_KEY",
    minimax: "MINIMAX_API_KEY",
    kimi: "MOONSHOT_API_KEY",
    zai: "ZAI_API_KEY",
    openrouter: "OPENROUTER_API_KEY",
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
    google: "gemini-2.5-flash",
    "openai-codex": "gpt-5.4",
    deepseek: "deepseek-v4-flash",
    qwen: "qwen-plus",
    minimax: "MiniMax-M2-Stable",
    kimi: "kimi-k2-0905",
    zai: "glm-4.6",
    openrouter: "deepseek/deepseek-chat",
  };

  const model =
    env("LLM_MODEL") ?? (llmYaml.model as string | undefined) ?? defaultModelMap[provider];

  const flushModel =
    env("LLM_FLUSH_MODEL") ?? (llmYaml.flush_model as string | undefined);

  const baseUrl =
    env("LLM_BASE_URL") ??
    (llmYaml.base_url as string | undefined) ??
    PROVIDER_BASE_URLS[provider];

  const config: Config = {
    llm: {
      provider,
      model,
      apiKey,
      authProfile:
        provider === "openai-codex"
          ? ((llmYaml.auth_profile as string | undefined) ?? "openai-codex")
          : undefined,
      flushModel,
      baseUrl,
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
      resetArchiveRetentionDays:
        envInt("SESSION_RESET_ARCHIVE_RETENTION_DAYS") ??
        (sessionYaml.resetArchiveRetentionDays as number) ??
        0,
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
