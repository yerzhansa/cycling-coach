import { intro, outro, select, text, password, confirm, isCancel, cancel, log } from "@clack/prompts";
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { stringify as toYaml } from "yaml";
import { CONFIG_DIR, CONFIG_FILE, readConfigYaml } from "./config.js";
import { runCodexLogin } from "./auth/openai-codex-login.js";
import { loadProfile, saveProfile, type OAuthCredential } from "./auth/profiles.js";

const PROVIDERS = [
  { value: "anthropic", label: "Anthropic (Claude)" },
  { value: "openai", label: "OpenAI (GPT)" },
  { value: "google", label: "Google (Gemini)" },
  { value: "openai-codex", label: "OpenAI Codex (ChatGPT subscription)", hint: "experimental" },
];

const API_KEY_LABELS: Record<string, string> = {
  anthropic: "Anthropic API key",
  openai: "OpenAI API key",
  google: "Google AI API key",
};

const MODELS: Record<string, { value: string; label: string; hint?: string }[]> = {
  anthropic: [
    { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", hint: "recommended" },
    { value: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5", hint: "fast & cheap" },
    { value: "claude-opus-4-6", label: "Claude Opus 4.6", hint: "most capable" },
  ],
  openai: [
    { value: "gpt-5.4", label: "GPT-5.4", hint: "recommended" },
    { value: "gpt-5.4-mini", label: "GPT-5.4 Mini", hint: "fast & cheap" },
    { value: "gpt-5.4-nano", label: "GPT-5.4 Nano", hint: "cheapest" },
    { value: "o4-mini", label: "o4-mini", hint: "reasoning" },
  ],
  google: [
    { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash", hint: "recommended" },
    { value: "gemini-2.5-pro", label: "Gemini 2.5 Pro", hint: "most capable" },
    { value: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash Lite", hint: "cheapest" },
  ],
  "openai-codex": [
    { value: "gpt-5.4", label: "GPT-5.4", hint: "recommended" },
    { value: "gpt-5.4-mini", label: "GPT-5.4 Mini", hint: "faster" },
  ],
};

const DEFAULT_MODELS: Record<string, string> = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-5.4",
  google: "gemini-2.5-flash",
  "openai-codex": "gpt-5.4",
};

function handleCancel(value: unknown): void {
  if (isCancel(value)) {
    cancel("Setup cancelled.");
    process.exit(0);
  }
}

function getString(obj: Record<string, unknown>, ...keys: string[]): string | undefined {
  let cur: unknown = obj;
  for (const k of keys) {
    if (cur && typeof cur === "object" && k in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[k];
    } else {
      return undefined;
    }
  }
  return typeof cur === "string" ? cur : undefined;
}

export async function runSetup(): Promise<void> {
  intro("Cycling Coach — Setup");

  const previous = readConfigYaml();
  const prevProvider = getString(previous, "llm", "provider");
  const prevModel = getString(previous, "llm", "model");
  const prevApiKey = getString(previous, "llm", "api_key");
  const prevIntervalsKey = getString(previous, "intervals", "api_key");
  const prevIntervalsId = getString(previous, "intervals", "athlete_id");
  const prevTelegramToken = getString(previous, "telegram", "bot_token");

  // Provider
  const providerResp = await select({
    message: "LLM provider",
    options: PROVIDERS,
    initialValue: prevProvider ?? "anthropic",
  });
  handleCancel(providerResp);
  const provider = providerResp as string;

  // API key (skipped for Codex OAuth). Empty input keeps the existing value.
  let apiKey = "";
  if (provider !== "openai-codex") {
    const hasPrev = provider === prevProvider && !!prevApiKey;
    const entered = await password({
      message: hasPrev
        ? `${API_KEY_LABELS[provider]} (Enter to keep existing)`
        : API_KEY_LABELS[provider],
      validate: (v) => {
        if (hasPrev) return undefined;
        return !v ? "API key is required" : undefined;
      },
    });
    handleCancel(entered);
    const entryStr = typeof entered === "string" ? entered : "";
    apiKey = entryStr || (hasPrev ? (prevApiKey as string) : "");
  }

  // Model
  const sameProvider = provider === prevProvider;
  const knownModel = MODELS[provider]?.some((m) => m.value === prevModel);
  const initialModel = sameProvider && prevModel
    ? (knownModel ? prevModel : "__custom__")
    : DEFAULT_MODELS[provider];
  const modelResp = await select({
    message: "Model",
    options: [
      ...(MODELS[provider] ?? []),
      { value: "__custom__", label: "Other (type model name)" },
    ],
    initialValue: initialModel,
  });
  handleCancel(modelResp);
  let model = modelResp as string;

  if (model === "__custom__") {
    const custom = await text({
      message: "Model name",
      defaultValue: sameProvider ? prevModel : undefined,
      placeholder: sameProvider ? prevModel : undefined,
      validate: (v) => (!v && !(sameProvider && prevModel) ? "Model name is required" : undefined),
    });
    handleCancel(custom);
    model = (typeof custom === "string" && custom) || prevModel || "";
  }

  // Codex OAuth — reuse existing profile unless the operator asks to re-login
  let freshCodexCreds: OAuthCredential | null = null;
  if (provider === "openai-codex") {
    const existing = loadProfile("openai-codex");
    let doLogin = true;
    if (existing) {
      const reuse = await confirm({
        message: "Existing Codex OAuth profile found. Re-login?",
        initialValue: false,
      });
      handleCancel(reuse);
      doLogin = Boolean(reuse);
    }
    if (doLogin) {
      log.info("Starting OAuth sign-in. ChatGPT Plus or higher required.");
      try {
        freshCodexCreds = await runCodexLogin();
        log.success("OpenAI Codex OAuth complete.");
      } catch (err) {
        cancel(`OAuth sign-in failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    }
  }

  // intervals.icu — Enter keeps prior; type new value to replace
  let intervalsKey = prevIntervalsKey ?? "";
  let intervalsAthleteId = prevIntervalsId ?? "";
  {
    const hasPrev = !!prevIntervalsKey;
    const entered = await password({
      message: hasPrev
        ? "intervals.icu API key (Enter to keep existing)"
        : "intervals.icu API key (Enter to skip)",
      validate: () => undefined,
    });
    handleCancel(entered);
    const entryStr = typeof entered === "string" ? entered : "";
    if (entryStr) {
      intervalsKey = entryStr;
      const athleteId = await text({
        message: "intervals.icu athlete ID",
        defaultValue: prevIntervalsId ?? "0",
        placeholder: prevIntervalsId ?? "0",
      });
      handleCancel(athleteId);
      intervalsAthleteId = (typeof athleteId === "string" && athleteId) || prevIntervalsId || "0";
    }
  }

  // Telegram — Enter keeps prior; type new value to replace
  let telegramToken = prevTelegramToken ?? "";
  {
    const hasPrev = !!prevTelegramToken;
    const entered = await password({
      message: hasPrev
        ? "Telegram bot token (Enter to keep existing)"
        : "Telegram bot token (Enter to skip)",
      validate: () => undefined,
    });
    handleCancel(entered);
    const entryStr = typeof entered === "string" ? entered : "";
    if (entryStr) telegramToken = entryStr;
  }

  // Build merged config — start from previous, replace only what changed.
  const merged: Record<string, unknown> = { ...previous };

  const llmConfig: Record<string, unknown> = { provider, model };
  if (provider === "openai-codex") {
    llmConfig.auth_profile = "openai-codex";
  } else {
    llmConfig.api_key = apiKey;
  }
  merged.llm = llmConfig;

  if (intervalsKey) {
    merged.intervals = {
      api_key: intervalsKey,
      athlete_id: intervalsAthleteId || "0",
    };
  } else {
    delete merged.intervals;
  }

  if (telegramToken) {
    merged.telegram = { bot_token: telegramToken };
  } else {
    delete merged.telegram;
  }

  // Confirm before writing when a prior config exists.
  if (existsSync(CONFIG_FILE)) {
    const ok = await confirm({
      message: `Update ${CONFIG_FILE}?`,
      initialValue: true,
    });
    handleCancel(ok);
    if (!ok) {
      log.info("No changes written.");
      return;
    }
  }

  const originalBytes = existsSync(CONFIG_FILE) ? readFileSync(CONFIG_FILE) : null;

  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, toYaml(merged), { mode: 0o600 });

  // Save Codex credentials only after the config write succeeds; roll the
  // config back if the save fails, so the two files stay in sync.
  if (freshCodexCreds) {
    try {
      saveProfile("openai-codex", freshCodexCreds);
    } catch (err) {
      if (originalBytes) {
        writeFileSync(CONFIG_FILE, originalBytes, { mode: 0o600 });
      } else {
        try { unlinkSync(CONFIG_FILE); } catch { /* best-effort */ }
      }
      cancel(`Failed to save OAuth profile: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  }

  outro(`Config written to ${CONFIG_FILE}\n  Run \`cycling-coach\` to start.`);
}
