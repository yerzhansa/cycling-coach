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
  dataDir: string;
}

// ============================================================================
// CONFIG LOADING
// ============================================================================

const CONFIG_DIR = join(homedir(), ".cycling-coach");
const CONFIG_FILE = join(CONFIG_DIR, "config.yaml");

function loadYamlConfig(): Record<string, unknown> {
  if (!existsSync(CONFIG_FILE)) return {};
  const raw = readFileSync(CONFIG_FILE, "utf-8");
  return (parseYaml(raw) as Record<string, unknown>) ?? {};
}

function env(key: string): string | undefined {
  return process.env[key];
}

export function loadConfig(): Config {
  const yaml = loadYamlConfig();
  const llmYaml = (yaml.llm as Record<string, string>) ?? {};
  const intervalsYaml = (yaml.intervals as Record<string, string>) ?? {};
  const telegramYaml = (yaml.telegram as Record<string, string>) ?? {};

  const provider = (env("LLM_PROVIDER") ??
    llmYaml.provider ??
    "anthropic") as Config["llm"]["provider"];

  const apiKeyMap: Record<string, string> = {
    anthropic: env("ANTHROPIC_API_KEY") ?? llmYaml.api_key ?? "",
    openai: env("OPENAI_API_KEY") ?? llmYaml.api_key ?? "",
    google: env("GOOGLE_GENERATIVE_AI_API_KEY") ?? llmYaml.api_key ?? "",
  };

  const modelMap: Record<string, string> = {
    anthropic: "claude-opus-4-6",
    openai: "gpt-4o",
    google: "gemini-2.0-flash",
  };

  return {
    llm: {
      provider,
      model: env("LLM_MODEL") ?? llmYaml.model ?? modelMap[provider],
      apiKey: apiKeyMap[provider],
    },
    intervals: {
      apiKey: env("INTERVALS_API_KEY") ?? intervalsYaml.api_key ?? "",
      athleteId: env("INTERVALS_ATHLETE_ID") ?? intervalsYaml.athlete_id ?? "0",
    },
    telegram: {
      botToken: env("TELEGRAM_BOT_TOKEN") ?? telegramYaml.bot_token ?? "",
    },
    dataDir: (yaml.data_dir as string) ?? CONFIG_DIR,
  };
}
