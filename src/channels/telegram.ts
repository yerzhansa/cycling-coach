import { Bot } from "grammy";
import type { CyclingCoachAgent } from "../agent/core.js";

// ============================================================================
// TELEGRAM BOT
// ============================================================================

export function createTelegramBot(token: string, agent: CyclingCoachAgent): Bot {
  const bot = new Bot(token);

  // ── Commands ────────────────────────────────────────────────────────────

  bot.command("start", async (ctx) => {
    await ctx.reply(
      "Welcome to Cycling Coach!\n\n" +
        "I'm your AI cycling coach. I can build training plans, suggest workouts, " +
        "and track your fitness using intervals.icu data.\n\n" +
        "Commands:\n" +
        "/plan — Generate a training plan\n" +
        "/workout — Get today's workout\n" +
        "/status — Check current form (CTL/ATL/TSB)\n" +
        "/sync — Push plan to intervals.icu calendar\n\n" +
        "Or just chat with me about your training!",
    );
  });

  bot.command("plan", async (ctx) => {
    await ctx.reply("Analyzing your data and building a plan...");
    const response = await agent.chat(
      "Generate a training plan for me. Fetch my athlete data first, " +
        "then build a periodized plan skeleton based on my profile. " +
        "Show me the plan summary and ask if I want to push it to my calendar.",
    );
    await sendLongMessage(ctx, response);
  });

  bot.command("workout", async (ctx) => {
    await ctx.reply("Checking your form and plan...");
    const response = await agent.chat(
      "What should my workout be today? Check my current form (CTL/ATL/TSB), " +
        "look at what phase I'm in, and suggest an appropriate workout. " +
        "Include the structured intervals and estimated TSS.",
    );
    await sendLongMessage(ctx, response);
  });

  bot.command("status", async (ctx) => {
    await ctx.reply("Fetching your fitness data...");
    const response = await agent.chat(
      "Show me my current training status. Fetch my wellness data for the last 2 weeks. " +
        "Show CTL (fitness), ATL (fatigue), TSB (form), and any trends. " +
        "Give me a coaching note about my current readiness.",
    );
    await sendLongMessage(ctx, response);
  });

  bot.command("sync", async (ctx) => {
    await ctx.reply("Syncing plan to calendar...");
    const response = await agent.chat(
      "Load my current plan and sync the next 1-2 weeks of workouts to my " +
        "intervals.icu calendar. Confirm what was pushed.",
    );
    await sendLongMessage(ctx, response);
  });

  // ── Free-form chat ──────────────────────────────────────────────────────

  bot.on("message:text", async (ctx) => {
    const response = await agent.chat(ctx.message.text);
    await sendLongMessage(ctx, response);
  });

  return bot;
}

// ============================================================================
// HELPERS
// ============================================================================

const TELEGRAM_MAX_LENGTH = 4096;

async function sendLongMessage(
  ctx: { reply: (text: string) => Promise<unknown> },
  text: string,
): Promise<void> {
  if (text.length <= TELEGRAM_MAX_LENGTH) {
    await ctx.reply(text);
    return;
  }

  // Split on paragraph boundaries
  const chunks: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    if (current.length + line.length + 1 > TELEGRAM_MAX_LENGTH) {
      chunks.push(current);
      current = line;
    } else {
      current += (current ? "\n" : "") + line;
    }
  }
  if (current) chunks.push(current);

  for (const chunk of chunks) {
    await ctx.reply(chunk);
  }
}
