import { createInterface } from "node:readline/promises";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { stringify as toYaml } from "yaml";
import { CONFIG_DIR, CONFIG_FILE } from "./config.js";

const PROVIDERS = ["anthropic", "openai", "google"] as const;

const API_KEY_LABELS: Record<string, string> = {
  anthropic: "Anthropic API key",
  openai: "OpenAI API key",
  google: "Google AI API key",
};

async function ask(
  rl: ReturnType<typeof createInterface>,
  prompt: string,
): Promise<string> {
  const answer = await rl.question(prompt);
  return answer.trim();
}

async function askRequired(
  rl: ReturnType<typeof createInterface>,
  prompt: string,
): Promise<string> {
  let value = "";
  while (!value) {
    value = await ask(rl, prompt);
    if (!value) console.log("  This field is required.");
  }
  return value;
}

async function askProvider(
  rl: ReturnType<typeof createInterface>,
): Promise<string> {
  while (true) {
    const value = await ask(rl, "  LLM provider (anthropic/openai/google) [anthropic]: ");
    if (!value) return "anthropic";
    if (PROVIDERS.includes(value as (typeof PROVIDERS)[number])) return value;
    console.log("  Must be one of: anthropic, openai, google");
  }
}

export async function runSetup(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  // Handle Ctrl+C
  rl.on("close", () => {
    console.log("\n  Setup cancelled.");
    process.exit(0);
  });

  try {
    console.log("\n  Cycling Coach — Setup\n");

    const provider = await askProvider(rl);
    const apiKey = await askRequired(rl, `  ${API_KEY_LABELS[provider]}: `);

    const intervalsKey = await ask(rl, "  intervals.icu API key (optional, Enter to skip): ");
    let intervalsAthleteId = "";
    if (intervalsKey) {
      intervalsAthleteId = await ask(rl, "  intervals.icu athlete ID [0]: ");
      if (!intervalsAthleteId) intervalsAthleteId = "0";
    }

    const telegramToken = await ask(rl, "  Telegram bot token (optional, Enter to skip): ");

    rl.close();

    // Check existing config
    if (existsSync(CONFIG_FILE)) {
      const confirm = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await confirm.question(`\n  ${CONFIG_FILE} already exists. Overwrite? (y/N): `);
      confirm.close();
      if (answer.trim().toLowerCase() !== "y") {
        console.log("  Setup cancelled.");
        return;
      }
    }

    // Build config object — only include non-empty sections
    const config: Record<string, unknown> = {
      llm: {
        provider,
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

    console.log(`\n  Config written to ${CONFIG_FILE}\n`);
    console.log("  Run `cycling-coach` to start.\n");
  } catch (err) {
    // readline throws on Ctrl+C in some Node versions
    if ((err as NodeJS.ErrnoException).code === "ERR_USE_AFTER_CLOSE") return;
    throw err;
  }
}
