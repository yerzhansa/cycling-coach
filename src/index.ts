import { loadConfig } from "./config.js";
import { CyclingCoachAgent } from "./agent/core.js";
import { createTelegramBot } from "./channels/telegram.js";

// ============================================================================
// ENTRY POINT
// ============================================================================

async function main() {
  const config = loadConfig();

  // Validate required config
  if (!config.llm.apiKey) {
    console.error(
      "No LLM API key found. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GOOGLE_GENERATIVE_AI_API_KEY.",
    );
    process.exit(1);
  }

  const agent = new CyclingCoachAgent(config);

  if (config.telegram.botToken) {
    // Telegram mode
    const bot = createTelegramBot(config.telegram.botToken, agent);
    console.log("Starting Telegram bot...");
    bot.start();
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
        const response = await agent.chat(input);
        console.log("\n" + response + "\n");
      } catch (err) {
        console.error("Error:", err);
      }
      rl.prompt();
    });
  }
}

main().catch(console.error);
