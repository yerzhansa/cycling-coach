import { Bot } from "grammy";
import type { CyclingCoachAgent } from "../agent/core.js";
import { isRateLimitError, extractRetryAfterMs } from "../agent/token-utils.js";
import {
  checkForUpdate,
  selfUpdate,
  getKnownTelegramChatIds,
  getCurrentVersion,
  getLastNotifiedVersion,
  setLastNotifiedVersion,
} from "../updater.js";

function formatRateLimitWait(err: unknown): string {
  const ms = extractRetryAfterMs(err);
  if (!ms) return "about a minute";
  const secs = Math.ceil(ms / 1000);
  if (secs < 60) return `~${secs} seconds`;
  return `~${Math.ceil(secs / 60)} minute${Math.ceil(secs / 60) > 1 ? "s" : ""}`;
}

// ============================================================================
// TELEGRAM BOT
// ============================================================================

const WELCOME_MESSAGE =
  "Welcome to Cycling Coach!\n\n" +
  "I'm your AI cycling coach. I can build training plans, suggest workouts, " +
  "and track your fitness using intervals.icu data.\n\n" +
  "Commands:\n" +
  "/plan — Generate a training plan\n" +
  "/workout — Get today's workout\n" +
  "/status — Check current fitness, fatigue, and form\n" +
  "/sync — Push plan to intervals.icu calendar\n" +
  "/version — Show current version\n" +
  "/update — Check for and install updates\n\n" +
  "Or just chat with me about your training!";

export function createTelegramBot(token: string, agent: CyclingCoachAgent): Bot {
  const bot = new Bot(token);
  const greeted = new Set<number>();

  // ── Commands ────────────────────────────────────────────────────────────

  bot.command("start", async (ctx) => {
    greeted.add(ctx.chat.id);
    try {
      await agent.resetSession(`telegram:${ctx.chat.id}`);
    } catch (err) {
      console.error("Error resetting session:", err);
    }
    await ctx.reply(WELCOME_MESSAGE);
  });

  bot.command("plan", async (ctx) => {
    await ctx.reply("Analyzing your data and building a plan...");
    const chatId = `telegram:${ctx.chat.id}`;
    try {
      const response = await agent.chat(chatId, "/plan");
      await sendLongMessage(ctx, response);
    } catch (err) {
      console.error("Error in /plan:", err);
      if (isRateLimitError(err)) {
        await ctx.reply(`Rate limited — please try again in ${formatRateLimitWait(err)}.`);
      } else {
        await ctx.reply("Sorry, something went wrong generating your plan. Please try again.");
      }
    }
  });

  bot.command("workout", async (ctx) => {
    await ctx.reply("Checking your form and plan...");
    const chatId = `telegram:${ctx.chat.id}`;
    try {
      const response = await agent.chat(chatId, "/workout");
      await sendLongMessage(ctx, response);
    } catch (err) {
      console.error("Error in /workout:", err);
      if (isRateLimitError(err)) {
        await ctx.reply(`Rate limited — please try again in ${formatRateLimitWait(err)}.`);
      } else {
        await ctx.reply("Sorry, something went wrong. Please try again.");
      }
    }
  });

  bot.command("status", async (ctx) => {
    await ctx.reply("Fetching your fitness data...");
    const chatId = `telegram:${ctx.chat.id}`;
    try {
      const response = await agent.chat(chatId, "/status");
      await sendLongMessage(ctx, response);
    } catch (err) {
      console.error("Error in /status:", err);
      if (isRateLimitError(err)) {
        await ctx.reply(`Rate limited — please try again in ${formatRateLimitWait(err)}.`);
      } else {
        await ctx.reply("Sorry, something went wrong. Please try again.");
      }
    }
  });

  bot.command("sync", async (ctx) => {
    await ctx.reply("Syncing plan to calendar...");
    const chatId = `telegram:${ctx.chat.id}`;
    try {
      const response = await agent.chat(chatId, "/sync");
      await sendLongMessage(ctx, response);
    } catch (err) {
      console.error("Error in /sync:", err);
      if (isRateLimitError(err)) {
        await ctx.reply(`Rate limited — please try again in ${formatRateLimitWait(err)}.`);
      } else {
        await ctx.reply("Sorry, something went wrong. Please try again.");
      }
    }
  });

  bot.command("version", async (ctx) => {
    await ctx.reply(`Cycling Coach v${getCurrentVersion()}`);
  });

  bot.command("update", async (ctx) => {
    await ctx.reply("Checking for updates...");
    try {
      const info = await checkForUpdate();
      if (!info) {
        await ctx.reply("Could not check for updates. Try again later.");
        return;
      }
      if (!info.updateAvailable) {
        await ctx.reply(`You're on the latest version (${info.current}).`);
        return;
      }
      await ctx.reply(`Updating ${info.current} → ${info.latest}...\nThe bot will stop after installation. Run \`cycling-coach\` to start it again.`);
      // Stop polling first so Telegram commits the /update offset — otherwise
      // Telegram re-sends /update on next startup and we loop forever.
      void bot.stop().then(selfUpdate);
    } catch (err) {
      console.error("Error in /update:", err);
      await ctx.reply("Update failed. Please run `npm install -g cycling-coach@latest` manually.");
    }
  });

  // ── Free-form chat ──────────────────────────────────────────────────────

  bot.on("message:text", async (ctx) => {
    const chatId = `telegram:${ctx.chat.id}`;

    // Welcome newcomers on their very first message
    if (!greeted.has(ctx.chat.id)) {
      greeted.add(ctx.chat.id);
      await ctx.reply(WELCOME_MESSAGE);
    }

    try {
      const response = await agent.chat(chatId, ctx.message.text);
      await sendLongMessage(ctx, response);
    } catch (err) {
      console.error("Error in chat:", err);
      if (isRateLimitError(err)) {
        const wait = formatRateLimitWait(err);
        await ctx.reply(
          `Your message was not processed (rate limited). Please wait ${wait} and resend:\n\n"${ctx.message.text.slice(0, 200)}"`,
        );
      } else {
        await ctx.reply("Sorry, something went wrong. Please try again.");
      }
    }
  });

  return bot;
}

// ============================================================================
// MARKDOWN → TELEGRAM HTML
// ============================================================================

function markdownToTelegramHtml(md: string): string {
  let html = md;

  // Headers: ### Title → <b>Title</b>
  html = html.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");

  // Bold: **text** → <b>text</b>
  html = html.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");

  // Italic: *text* or _text_ → <i>text</i>
  html = html.replace(/(?<!\w)\*([^*]+?)\*(?!\w)/g, "<i>$1</i>");
  html = html.replace(/(?<!\w)_([^_]+?)_(?!\w)/g, "<i>$1</i>");

  // Inline code: `text` → <code>text</code>
  html = html.replace(/`([^`]+?)`/g, "<code>$1</code>");

  // Code blocks: ```...``` → <pre>...</pre>
  html = html.replace(/```[\w]*\n?([\s\S]*?)```/g, "<pre>$1</pre>");

  // Strikethrough: ~~text~~ → <s>text</s>
  html = html.replace(/~~(.+?)~~/g, "<s>$1</s>");

  // Bullet points: - item → • item
  html = html.replace(/^[-*]\s+/gm, "• ");

  // Escape remaining HTML-special chars (but not our tags)
  html = html.replace(/&(?!amp;|lt;|gt;)/g, "&amp;");
  html = html.replace(/<(?!\/?(?:b|i|u|s|code|pre)>)/g, "&lt;");

  return html;
}

// ============================================================================
// SEND WITH CHUNKING
// ============================================================================

const TELEGRAM_MAX_LENGTH = 4096;

async function sendLongMessage(
  ctx: { reply: (text: string, options?: Record<string, unknown>) => Promise<unknown> },
  text: string,
): Promise<void> {
  const html = markdownToTelegramHtml(text);

  if (html.length <= TELEGRAM_MAX_LENGTH) {
    await ctx.reply(html, { parse_mode: "HTML" });
    return;
  }

  // Split on paragraph boundaries, hard-split lines that exceed the limit
  const chunks: string[] = [];
  let current = "";
  for (const line of html.split("\n")) {
    if (line.length > TELEGRAM_MAX_LENGTH) {
      if (current) { chunks.push(current); current = ""; }
      for (let i = 0; i < line.length; i += TELEGRAM_MAX_LENGTH) {
        chunks.push(line.slice(i, i + TELEGRAM_MAX_LENGTH));
      }
    } else if (current.length + line.length + 1 > TELEGRAM_MAX_LENGTH) {
      chunks.push(current);
      current = line;
    } else {
      current += (current ? "\n" : "") + line;
    }
  }
  if (current) chunks.push(current);

  for (const chunk of chunks) {
    await ctx.reply(chunk, { parse_mode: "HTML" });
  }
}

// ============================================================================
// STARTUP UPDATE NOTIFICATION
// ============================================================================

export async function notifyUpdate(bot: Bot, dataDir: string): Promise<void> {
  try {
    const info = await checkForUpdate();
    if (!info?.updateAvailable) return;

    if (getLastNotifiedVersion(dataDir) === info.latest) return;

    const chatIds = getKnownTelegramChatIds(dataDir);
    const message = `Update available: ${info.current} → ${info.latest}\nSend /update to install.`;

    for (const chatId of chatIds) {
      try {
        await bot.api.sendMessage(chatId, message);
      } catch {
        // Chat may no longer exist or bot was removed
      }
    }

    setLastNotifiedVersion(dataDir, info.latest);
  } catch {
    // Non-critical — don't crash the bot
  }
}
