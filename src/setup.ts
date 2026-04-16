import { intro, outro, select, text, password, confirm, isCancel, cancel } from "@clack/prompts";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { stringify as toYaml } from "yaml";
import { CONFIG_DIR, CONFIG_FILE } from "./config.js";

const PROVIDERS = [
  { value: "anthropic", label: "Anthropic (Claude)" },
  { value: "openai", label: "OpenAI (GPT)" },
  { value: "google", label: "Google (Gemini)" },
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
};

function handleCancel(value: unknown): asserts value is string | boolean {
  if (isCancel(value)) {
    cancel("Setup cancelled.");
    process.exit(0);
  }
}

export async function runSetup(): Promise<void> {
  intro("Cycling Coach — Setup");

  // Provider
  const provider = await select({
    message: "LLM provider",
    options: PROVIDERS,
  });
  handleCancel(provider);

  // API key
  const apiKey = await password({
    message: API_KEY_LABELS[provider],
    validate: (v) => (!v ? "API key is required" : undefined),
  });
  handleCancel(apiKey);

  // Model
  const model = await select({
    message: "Model",
    options: MODELS[provider] ?? [],
  });
  handleCancel(model);

  // intervals.icu (optional)
  const intervalsKey = await text({
    message: "intervals.icu API key",
    placeholder: "Enter to skip",
  });
  handleCancel(intervalsKey);

  let intervalsAthleteId = "";
  if (intervalsKey) {
    const athleteId = await text({
      message: "intervals.icu athlete ID",
      defaultValue: "0",
      placeholder: "0",
    });
    handleCancel(athleteId);
    intervalsAthleteId = athleteId || "0";
  }

  // Telegram (optional)
  const telegramToken = await text({
    message: "Telegram bot token",
    placeholder: "Enter to skip",
  });
  handleCancel(telegramToken);

  // Overwrite check
  if (existsSync(CONFIG_FILE)) {
    const overwrite = await confirm({
      message: `${CONFIG_FILE} already exists. Overwrite?`,
    });
    handleCancel(overwrite);
    if (!overwrite) {
      cancel("Setup cancelled.");
      process.exit(0);
    }
  }

  // Build config — only include non-empty sections
  const config: Record<string, unknown> = {
    llm: {
      provider,
      model,
      api_key: apiKey,
    },
  };

  if (intervalsKey) {
    config.intervals = {
      api_key: intervalsKey,
      athlete_id: intervalsAthleteId,
    };
  }

  if (telegramToken) {
    config.telegram = {
      bot_token: telegramToken,
    };
  }

  // Write config
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, toYaml(config), { mode: 0o600 });

  outro(`Config written to ${CONFIG_FILE}\n  Run \`cycling-coach\` to start.`);
}
