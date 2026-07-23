export const LLM_PROVIDERS = [
  "anthropic",
  "openai",
  "google",
  "openai-codex",
  "deepseek",
  "qwen",
  "minimax",
  "kimi",
  "zai",
  "openrouter",
] as const;

export type LlmProvider = (typeof LLM_PROVIDERS)[number];

export const DEFAULT_MODELS = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-5.5",
  google: "gemini-3.5-flash",
  "openai-codex": "gpt-5.5",
  deepseek: "deepseek-v4-flash",
  qwen: "qwen3.5-plus",
  minimax: "MiniMax-M2.7",
  kimi: "kimi-k2.6",
  zai: "glm-4.7",
  openrouter: "deepseek/deepseek-v4-flash",
} as const satisfies Record<LlmProvider, string>;

export const PROVIDER_BASE_URLS = {
  deepseek: "https://api.deepseek.com/v1",
  qwen: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
  minimax: "https://api.minimax.io/v1",
  kimi: "https://api.moonshot.ai/v1",
  zai: "https://api.z.ai/api/openai/v1",
  openrouter: "https://openrouter.ai/api/v1",
} as const satisfies Partial<Record<LlmProvider, string>>;

export interface LlmModelOption {
  readonly value: string;
  readonly label: string;
  readonly hint?: string;
}

export interface LlmModelCatalogueEntry {
  readonly provider: LlmProvider;
  readonly label: string;
  readonly hint?: string;
  readonly defaultModel: string;
  readonly models: readonly LlmModelOption[];
  readonly defaultBaseUrl?: string;
}

export const LLM_MODEL_CATALOGUE: readonly LlmModelCatalogueEntry[] = [
  {
    provider: "anthropic",
    label: "Anthropic (Claude)",
    defaultModel: DEFAULT_MODELS.anthropic,
    models: [
      { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", hint: "recommended" },
      { value: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5", hint: "fast & cheap" },
      { value: "claude-opus-4-8", label: "Claude Opus 4.8", hint: "most capable" },
    ],
  },
  {
    provider: "openai",
    label: "OpenAI (GPT)",
    defaultModel: DEFAULT_MODELS.openai,
    models: [
      { value: "gpt-5.5", label: "GPT-5.5", hint: "recommended" },
      { value: "gpt-5.4-mini", label: "GPT-5.4 Mini", hint: "fast & cheap" },
      { value: "gpt-5.4-nano", label: "GPT-5.4 Nano", hint: "cheapest" },
    ],
  },
  {
    provider: "google",
    label: "Google (Gemini)",
    defaultModel: DEFAULT_MODELS.google,
    models: [
      { value: "gemini-3.5-flash", label: "Gemini 3.5 Flash", hint: "recommended" },
      { value: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro", hint: "most capable" },
      { value: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash Lite", hint: "cheapest" },
    ],
  },
  {
    provider: "openai-codex",
    label: "OpenAI Codex (ChatGPT subscription)",
    hint: "experimental",
    defaultModel: DEFAULT_MODELS["openai-codex"],
    models: [
      { value: "gpt-5.5", label: "GPT-5.5", hint: "recommended" },
      { value: "gpt-5.4-mini", label: "GPT-5.4 Mini", hint: "faster" },
    ],
  },
  {
    provider: "deepseek",
    label: "DeepSeek",
    defaultModel: DEFAULT_MODELS.deepseek,
    defaultBaseUrl: PROVIDER_BASE_URLS.deepseek,
    models: [
      { value: "deepseek-v4-flash", label: "DeepSeek V4 Flash", hint: "recommended" },
      { value: "deepseek-v4-pro", label: "DeepSeek V4 Pro", hint: "most capable" },
    ],
  },
  {
    provider: "qwen",
    label: "Qwen (Alibaba Model Studio)",
    defaultModel: DEFAULT_MODELS.qwen,
    defaultBaseUrl: PROVIDER_BASE_URLS.qwen,
    models: [
      { value: "qwen3.5-plus", label: "Qwen3.5 Plus", hint: "recommended" },
      { value: "qwen3-max", label: "Qwen3 Max", hint: "most capable" },
    ],
  },
  {
    provider: "minimax",
    label: "MiniMax",
    defaultModel: DEFAULT_MODELS.minimax,
    defaultBaseUrl: PROVIDER_BASE_URLS.minimax,
    models: [
      { value: "MiniMax-M2.7", label: "MiniMax M2.7", hint: "recommended" },
      { value: "MiniMax-M3", label: "MiniMax M3", hint: "most capable" },
    ],
  },
  {
    provider: "kimi",
    label: "Kimi (Moonshot AI)",
    defaultModel: DEFAULT_MODELS.kimi,
    defaultBaseUrl: PROVIDER_BASE_URLS.kimi,
    models: [
      { value: "kimi-k2.6", label: "Kimi K2.6", hint: "recommended" },
      { value: "kimi-k2.5", label: "Kimi K2.5", hint: "cheaper" },
    ],
  },
  {
    provider: "zai",
    label: "Z.AI (GLM)",
    defaultModel: DEFAULT_MODELS.zai,
    defaultBaseUrl: PROVIDER_BASE_URLS.zai,
    models: [
      { value: "glm-4.7", label: "GLM-4.7", hint: "recommended" },
      { value: "glm-5.2", label: "GLM-5.2", hint: "most capable" },
      { value: "glm-4.7-flashx", label: "GLM-4.7 FlashX", hint: "cheapest" },
    ],
  },
  {
    provider: "openrouter",
    label: "OpenRouter",
    hint: "one key, many models",
    defaultModel: DEFAULT_MODELS.openrouter,
    defaultBaseUrl: PROVIDER_BASE_URLS.openrouter,
    models: [
      {
        value: "deepseek/deepseek-v4-flash",
        label: "DeepSeek V4 Flash (via OpenRouter)",
        hint: "cheap",
      },
      { value: "z-ai/glm-5.2", label: "GLM-5.2 (via OpenRouter)", hint: "most capable" },
      { value: "qwen/qwen3.7-plus", label: "Qwen3.7 Plus (via OpenRouter)" },
      { value: "moonshotai/kimi-k2.6", label: "Kimi K2.6 (via OpenRouter)" },
    ],
  },
] as const;

export const COMPACT_MODEL_DEFAULTS = {
  anthropic: "claude-haiku-4-5-20251001",
  openrouter: "deepseek/deepseek-v4-flash",
} as const satisfies Partial<Record<LlmProvider, string>>;

const CONTEXT_WINDOWS: Readonly<Record<string, number>> = {
  "claude-sonnet-4-6": 1_000_000,
  "claude-opus-4-8": 1_000_000,
  "claude-haiku-4-5-20251001": 200_000,
  "gpt-4o": 128_000,
  "gpt-5.5": 1_050_000,
  "gpt-5.4": 1_050_000,
  "gpt-5.4-mini": 400_000,
  "gpt-5.4-nano": 400_000,
  "gemini-3.5-flash": 1_048_576,
  "gemini-3.1-pro-preview": 1_048_576,
  "gemini-3.1-flash-lite": 1_048_576,
  "deepseek-v4-flash": 1_000_000,
  "deepseek-v4-pro": 1_000_000,
  "qwen3.5-plus": 1_000_000,
  "qwen3-max": 262_144,
  "MiniMax-M2.7": 204_800,
  "MiniMax-M3": 1_000_000,
  "kimi-k2.6": 262_144,
  "kimi-k2.5": 262_144,
  "glm-5.2": 1_000_000,
  "glm-4.7": 200_000,
  "glm-4.7-flashx": 200_000,
  "deepseek/deepseek-v4-flash": 1_000_000,
  "z-ai/glm-5.2": 1_000_000,
  "qwen/qwen3.7-plus": 1_000_000,
  "moonshotai/kimi-k2.6": 262_000,
};

export interface EffectiveRuntimeConfig {
  llm: {
    provider: LlmProvider;
    model: string;
    apiKey: string;
    authProfile?: string;
    flushModel?: string;
    compactModel?: string;
    baseUrl?: string;
  };
  intervals: {
    apiKey: string;
    athleteId: string;
  };
  session: {
    historyTokenBudgetRatio: number;
    idleMinutes: number;
    dailyResetHour: number;
    resetArchiveRetentionDays: number;
    timezone: string;
  };
  contextWindowTokens: number;
}

export interface RuntimeConfigPatch {
  readonly llm?: {
    readonly provider?: LlmProvider;
    readonly model?: string;
    readonly apiKey?: string;
    readonly flushModel?: string | null;
    readonly compactModel?: string | null;
    readonly baseUrl?: string | null;
  };
  readonly intervals?: {
    readonly apiKey?: string;
    readonly athleteId?: string;
  };
  readonly session?: Partial<EffectiveRuntimeConfig["session"]>;
}

export interface RuntimeConfigResolverOptions {
  readonly contextWindowTokens?: number;
  readonly authProfile?: string;
}

const ROOT_FIELDS = new Set(["llm", "intervals", "session"]);
const LLM_FIELDS = new Set([
  "provider",
  "model",
  "apiKey",
  "flushModel",
  "compactModel",
  "baseUrl",
]);
const INTERVALS_FIELDS = new Set(["apiKey", "athleteId"]);
const SESSION_FIELDS = new Set([
  "historyTokenBudgetRatio",
  "idleMinutes",
  "dailyResetHour",
  "resetArchiveRetentionDays",
  "timezone",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertKnownFields(value: unknown, fields: ReadonlySet<string>, name: string): void {
  if (!isRecord(value)) throw new TypeError(`${name} must be a map.`);
  for (const field of Object.keys(value)) {
    if (!fields.has(field)) throw new TypeError(`Unknown ${name} field: ${field}.`);
  }
}

function isSpecified(value: object, field: string): boolean {
  return Object.hasOwn(value, field) && (value as Record<string, unknown>)[field] !== undefined;
}

function requireString(value: unknown, name: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new TypeError(`${name} must be ${allowEmpty ? "a string" : "a non-empty string"}.`);
  }
  return value;
}

function requireFiniteNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number.`);
  }
  return value;
}

function requireInteger(value: unknown, name: string): number {
  const parsed = requireFiniteNumber(value, name);
  if (!Number.isInteger(parsed)) throw new TypeError(`${name} must be an integer.`);
  return parsed;
}

export function resolveLlmProvider(value: unknown): LlmProvider {
  if (typeof value === "string" && (LLM_PROVIDERS as readonly string[]).includes(value)) {
    return value as LlmProvider;
  }
  throw new TypeError("Unsupported LLM provider.");
}

export function contextWindowForModel(model: string): number {
  return CONTEXT_WINDOWS[model] ?? 200_000;
}

function providerBaseUrl(provider: LlmProvider): string | undefined {
  return PROVIDER_BASE_URLS[provider as keyof typeof PROVIDER_BASE_URLS];
}

function compactModelDefault(provider: LlmProvider): string | undefined {
  return COMPACT_MODEL_DEFAULTS[provider as keyof typeof COMPACT_MODEL_DEFAULTS];
}

function optionalModel(
  patch: NonNullable<RuntimeConfigPatch["llm"]>,
  field: "flushModel" | "compactModel",
): string | null | undefined {
  if (!isSpecified(patch, field)) return undefined;
  const value = patch[field];
  return value === null ? null : requireString(value, `llm.${field}`);
}

export function resolveRuntimeConfig(
  patch: RuntimeConfigPatch = {},
  current?: EffectiveRuntimeConfig,
  options: RuntimeConfigResolverOptions = {},
): EffectiveRuntimeConfig {
  assertKnownFields(patch, ROOT_FIELDS, "runtime config");
  const llmPatch = patch.llm ?? {};
  const intervalsPatch = patch.intervals ?? {};
  const sessionPatch = patch.session ?? {};
  assertKnownFields(llmPatch, LLM_FIELDS, "llm");
  assertKnownFields(intervalsPatch, INTERVALS_FIELDS, "intervals");
  assertKnownFields(sessionPatch, SESSION_FIELDS, "session");

  const provider = isSpecified(llmPatch, "provider")
    ? resolveLlmProvider(llmPatch.provider)
    : (current?.llm.provider ?? "anthropic");
  const providerChanged = current !== undefined && provider !== current.llm.provider;
  const model = isSpecified(llmPatch, "model")
    ? requireString(llmPatch.model, "llm.model")
    : current !== undefined && !providerChanged
      ? current.llm.model
      : DEFAULT_MODELS[provider];
  const selectionChanged = current === undefined || providerChanged || model !== current.llm.model;
  const apiKey =
    provider === "openai-codex"
      ? ""
      : isSpecified(llmPatch, "apiKey")
        ? requireString(llmPatch.apiKey, "llm.apiKey", true)
        : current !== undefined && !providerChanged
          ? current.llm.apiKey
          : "";
  if (provider === "openai-codex" && isSpecified(llmPatch, "apiKey")) {
    throw new TypeError("llm.apiKey must be absent for openai-codex.");
  }

  const requestedFlushModel = optionalModel(llmPatch, "flushModel");
  const flushModel =
    requestedFlushModel === null
      ? undefined
      : (requestedFlushModel ??
        (current !== undefined && !providerChanged ? current.llm.flushModel : undefined));

  const requestedCompactModel = optionalModel(llmPatch, "compactModel");
  const compactModel =
    provider === "openai-codex"
      ? model
      : requestedCompactModel === null
        ? (compactModelDefault(provider) ?? model)
        : (requestedCompactModel ??
          (current !== undefined && !providerChanged
            ? model !== current.llm.model && current.llm.compactModel === current.llm.model
              ? model
              : current.llm.compactModel
            : (compactModelDefault(provider) ?? model)));

  let baseUrl: string | undefined;
  if (isSpecified(llmPatch, "baseUrl")) {
    baseUrl =
      llmPatch.baseUrl === null
        ? providerBaseUrl(provider)
        : requireString(llmPatch.baseUrl, "llm.baseUrl", true) || undefined;
  } else {
    baseUrl =
      current !== undefined && !providerChanged ? current.llm.baseUrl : providerBaseUrl(provider);
  }

  const intervalsApiKeySpecified = isSpecified(intervalsPatch, "apiKey");
  const intervalsApiKey = intervalsApiKeySpecified
    ? requireString(intervalsPatch.apiKey, "intervals.apiKey", true)
    : (current?.intervals.apiKey ?? "");
  const intervals = {
    apiKey: intervalsApiKey,
    athleteId: isSpecified(intervalsPatch, "athleteId")
      ? requireString(intervalsPatch.athleteId, "intervals.athleteId", current === undefined)
      : current?.intervals.athleteId === "" &&
          intervalsApiKeySpecified &&
          intervalsApiKey.length > 0
        ? "0"
        : (current?.intervals.athleteId ?? "0"),
  };

  const session = {
    historyTokenBudgetRatio: isSpecified(sessionPatch, "historyTokenBudgetRatio")
      ? requireFiniteNumber(sessionPatch.historyTokenBudgetRatio, "session.historyTokenBudgetRatio")
      : (current?.session.historyTokenBudgetRatio ?? 0.3),
    idleMinutes: isSpecified(sessionPatch, "idleMinutes")
      ? requireInteger(sessionPatch.idleMinutes, "session.idleMinutes")
      : (current?.session.idleMinutes ?? 0),
    dailyResetHour: isSpecified(sessionPatch, "dailyResetHour")
      ? requireInteger(sessionPatch.dailyResetHour, "session.dailyResetHour")
      : (current?.session.dailyResetHour ?? 4),
    resetArchiveRetentionDays: isSpecified(sessionPatch, "resetArchiveRetentionDays")
      ? requireInteger(sessionPatch.resetArchiveRetentionDays, "session.resetArchiveRetentionDays")
      : (current?.session.resetArchiveRetentionDays ?? 0),
    timezone: isSpecified(sessionPatch, "timezone")
      ? requireString(sessionPatch.timezone, "session.timezone", true)
      : (current?.session.timezone ?? ""),
  };

  const contextWindowTokens =
    options.contextWindowTokens !== undefined
      ? requireInteger(options.contextWindowTokens, "contextWindowTokens")
      : current !== undefined && !selectionChanged
        ? current.contextWindowTokens
        : contextWindowForModel(model);
  if (contextWindowTokens <= 0) throw new TypeError("contextWindowTokens must be positive.");

  const authProfile =
    provider === "openai-codex"
      ? isSpecified(llmPatch, "provider")
        ? options.authProfile === undefined
          ? "openai-codex"
          : requireString(options.authProfile, "authProfile")
        : current !== undefined
          ? (current.llm.authProfile ?? "openai-codex")
          : options.authProfile === undefined
            ? "openai-codex"
            : requireString(options.authProfile, "authProfile")
      : undefined;

  return {
    llm: {
      provider,
      model,
      apiKey,
      authProfile,
      flushModel,
      compactModel,
      baseUrl,
    },
    intervals,
    session,
    contextWindowTokens,
  };
}
