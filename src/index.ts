#!/usr/bin/env node
import { parseArgs } from "node:util";
import { loadConfig } from "./config.js";
import { CyclingCoachAgent } from "./agent/core.js";
import { createTelegramBot, notifyUpdate } from "./channels/telegram.js";

// ============================================================================
// CLI ROUTING
// ============================================================================

const USAGE = `Usage: cycling-coach [command]

Commands:
  setup    Interactive wizard to create ~/.cycling-coach/config.yaml
  version  Show current version
  (none)   Start the coaching agent (Telegram or CLI mode)

Options:
  --help   Show this help message`;

function parseCommand(): string | null {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { help: { type: "boolean" } },
    strict: false,
  });
  if (values.help) {
    console.log(USAGE);
    process.exit(0);
  }
  return positionals[0] ?? null;
}

// ============================================================================
// ENTRY POINT
// ============================================================================

async function main() {
  const command = parseCommand();

  if (command === "setup") {
    const { runSetup } = await import("./setup.js");
    await runSetup();
    // pi-ai's OAuth callback server may leave socket/timer handles alive;
    // exit explicitly so the wizard returns the shell.
    process.exit(0);
  }

  if (command === "version") {
    const { getCurrentVersion } = await import("./updater.js");
    console.log(`cycling-coach v${getCurrentVersion()}`);
    return;
  }

  if (command) {
    console.error(`Unknown command: ${command}\n`);
    console.log(USAGE);
    process.exit(1);
  }

  const config = loadConfig();

  // Validate required config
  if (config.llm.provider !== "openai-codex" && !config.llm.apiKey) {
    console.error(
      "No LLM API key found. Run `cycling-coach setup` to configure, or set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GOOGLE_GENERATIVE_AI_API_KEY.",
    );
    process.exit(1);
  }

  const agent = new CyclingCoachAgent(config);

  if (config.telegram.botToken) {
    // Telegram mode
    const bot = createTelegramBot(config.telegram.botToken, agent);
    console.log("Cycling Coach is running. Waiting for messages...");
    bot.start();
    notifyUpdate(bot, config.dataDir).catch(() => {});
  } else {
    // CLI mode — read from stdin
    console.log("Cycling Coach (CLI mode). Type your message:");
    const { createInterface } = await import("node:readline");
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: "> ",
    });

    rl.prompt();
    rl.on("line", async (line) => {
      const input = line.trim();
      if (!input) {
        rl.prompt();
        return;
      }
      if (input === "/quit" || input === "/exit") {
        rl.close();
        return;
      }

      try {
        const response = await agent.chat("cli", input);
        console.log("\n" + response + "\n");
      } catch (err) {
        console.error("Error:", err);
      }
      rl.prompt();
    });
  }
}

main().catch(console.error);
