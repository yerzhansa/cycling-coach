import { parseArgs } from "node:util";
import type { Sport } from "./sport.js";
import type { BinaryConfig } from "./binary.js";
import type { Memory } from "./memory/store.js";

export interface RunBinaryHooks {
  /** Called once per process at startup, after Memory exists, before any chat handler is reachable. */
  onStartup?: (memory: Memory) => void | Promise<void>;
}

function usage(binary: BinaryConfig): string {
  return `Usage: ${binary.binaryName} [command]

Commands:
  setup    Interactive wizard to create the config file
  version  Show current version
  (none)   Start the coaching agent (Telegram or CLI mode)

Options:
  --help   Show this help message`;
}

function parseCommand(binary: BinaryConfig): string | null {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { help: { type: "boolean" } },
    strict: false,
  });
  if (values.help) {
    console.log(usage(binary));
    process.exit(0);
  }
  return positionals[0] ?? null;
}

export async function runBinary(
  sport: Sport,
  binary: BinaryConfig,
  hooks: RunBinaryHooks = {},
): Promise<void> {
  const command = parseCommand(binary);

  if (command === "setup") {
    const { runSetup } = await import("./setup.js");
    await runSetup(binary);
    // pi-ai's OAuth callback server may leave socket/timer handles alive;
    // exit explicitly so the wizard returns the shell.
    process.exit(0);
  }

  if (command === "version") {
    const { getCurrentVersion } = await import("./updater.js");
    console.log(`${binary.binaryName} v${getCurrentVersion(binary.binaryName)}`);
    return;
  }

  if (command) {
    console.error(`Unknown command: ${command}\n`);
    console.log(usage(binary));
    process.exit(1);
  }

  const { loadConfig, resolveConfigSecrets } = await import("./config.js");
  const { SecretResolutionError } = await import("./secrets/types.js");

  let config;
  try {
    config = await resolveConfigSecrets(loadConfig());
  } catch (err) {
    if (err instanceof SecretResolutionError) {
      console.error(`Config error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  if (config.llm.provider !== "openai-codex" && !config.llm.apiKey) {
    console.error(
      `No LLM API key found. Run \`${binary.binaryName} setup\` to configure, or set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GOOGLE_GENERATIVE_AI_API_KEY.`,
    );
    process.exit(1);
  }

  const { CoachAgent } = await import("./agent/coach-agent.js");
  const agent = new CoachAgent(sport, config);

  if (hooks.onStartup) {
    await hooks.onStartup(agent.getMemory());
  }

  if (config.telegram.botToken) {
    const { createTelegramBot, notifyUpdate } = await import("./channels/telegram.js");
    const bot = createTelegramBot(config.telegram.botToken, agent, binary);
    console.log(`${binary.displayName} is running. Waiting for messages...`);
    bot.start();
    notifyUpdate(bot, config.dataDir, binary).catch(() => {});
  } else {
    console.log(`${binary.displayName} (CLI mode). Type your message:`);
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
