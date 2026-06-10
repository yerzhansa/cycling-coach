import { Bot, InputFile } from "grammy";
import type { CoachAgent } from "../agent/coach-agent.js";
import type { BinaryConfig } from "../binary.js";
import { isRateLimitError, extractRetryAfterMs } from "../agent/token-utils.js";
import {
  checkForUpdate,
  selfUpdate,
  getKnownTelegramChatIds,
  getCurrentVersion,
  getLastNotifiedVersion,
  setLastNotifiedVersion,
} from "../updater.js";
import { buildWhatsNewMessage } from "../release-notes.js";
import { createAuthMiddleware } from "./telegram-access.js";
import { loadAllowedSenders, loadAllowedSendersWithSource } from "./allowed-senders.js";
import { escapeHtmlText } from "./html-escape.js";
import type { ReferenceServices } from "../reference/services.js";
import { formatSyncReply } from "../reference/sync/format-sync-reply.js";
import { formatSnapshotRaw } from "../reference/sync/snapshot-debug.js";
import { sendSnapshotOutput } from "../reference/sync/send-snapshot.js";

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
  "/review — Review your last session\n" +
  "/sync — Force-refresh training data from intervals.icu\n" +
  "/version — Show current version\n" +
  "/whatsnew — See what changed in the latest version\n" +
  "/update — Check for and install updates\n\n" +
  "Or just chat with me about your training!";

const SNAPSHOT_HELP =
  "/snapshot raw [section]    — dump pre-curation latest.json (or one section)\n" +
  "/snapshot help             — show this list\n\n" +
  "Future variants of /snapshot will surface metrics, activities, wellness,\n" +
  "intervals, routes, history, FTP, and validation cuts. For now, only\n" +
  "/snapshot raw is wired.";

// Module-private factory: every Bot in this module is constructed here, with
// the auth middleware registered FIRST. Future maintainers cannot add a handler
// ahead of auth without modifying this function — and reviewers scrutinize
// changes here because this file holds the security model.
function createSecuredBot(opts: {
  token: string;
  binary: BinaryConfig;
  dataDir: string;
}): Bot {
  const bot = new Bot(opts.token);

  // Per-sender pairing-challenge rate-limit map (process-lifetime; LRU-bounded).
  const challengeRateLimit = new Map<string, number>();
  bot.use(
    createAuthMiddleware({
      dataDir: opts.dataDir,
      binaryName: opts.binary.binaryName,
      challengeRateLimit,
      challengeMinIntervalMs: 60_000,
    }),
  );

  return bot;
}

function logSecurityStartup(dataDir: string, binaryName: string): void {
  const { state, source } = loadAllowedSendersWithSource(dataDir);
  const primary = state.primaryOperator ?? "none";
  if (state.dmPolicy === "open") {
    console.error(
      "[security] WARNING: DM policy is OPEN — this bot will answer ANY Telegram user who finds it.\n" +
        "[security] WARNING: Unset CYCLING_COACH_DM_POLICY to restore allowlist/pairing.\n" +
        `[security] Allowlist on record: ${state.allowFrom.length} senders (primary: ${primary}). Source: ${source}.`,
    );
    return;
  }
  console.error(
    `[security] Telegram allowlist: ${state.dmPolicy} mode (${state.allowFrom.length} allowed senders, primary: ${primary}). Source: ${source}.`,
  );
  if (state.dmPolicy === "pairing" && state.allowFrom.length === 0) {
    console.error(
      `[security] No allowed senders configured. DM the bot to receive your user-ID, then run \`${binaryName} add-sender <id>\` to authorize yourself.`,
    );
  }
}

export function createTelegramBot(
  token: string,
  agent: CoachAgent,
  binary: BinaryConfig,
  dataDir: string,
  reference?: ReferenceServices,
): Bot {
  logSecurityStartup(dataDir, binary.binaryName);
  const bot = createSecuredBot({ token, binary, dataDir });
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

  if (reference !== undefined) {
    bot.command("sync", async (ctx) => {
      await ctx.reply("Syncing training data from intervals.icu...");
      try {
        const result = await reference.runSync({
          chatId: `telegram:${ctx.chat.id}`,
        });
        await ctx.reply(formatSyncReply(result));
      } catch (err) {
        console.error("Error in /sync:", err);
        await ctx.reply("Sorry, something went wrong syncing. Please try again.");
      }
    });

    bot.command("snapshot", async (ctx) => {
      const args = (ctx.match ?? "").trim().split(/\s+/).filter(Boolean);
      const sub = args[0]?.toLowerCase() ?? "help";

      if (sub === "help") {
        await ctx.reply(SNAPSHOT_HELP);
        return;
      }

      if (sub === "raw") {
        const section = args[1];
        const latest = reference.loadLatest();
        const output = formatSnapshotRaw(latest, section);
        try {
          await sendSnapshotOutput(output, {
            reply: (text) => ctx.reply(text, { parse_mode: "Markdown" }) as Promise<unknown>,
            sendDocument: (buffer, filename) =>
              ctx.replyWithDocument(new InputFile(buffer, filename)) as Promise<unknown>,
          });
        } catch (err) {
          console.error("Error in /snapshot raw:", err);
          await ctx.reply("Sorry, something went wrong rendering the snapshot.");
        }
        return;
      }

      await ctx.reply(SNAPSHOT_HELP);
    });
  }

  bot.command("review", async (ctx) => {
    const args = (ctx.match ?? "").trim();
    await ctx.reply(
      args ? `Reviewing your last session (${args})...` : "Reviewing your last session...",
    );
    const chatId = `telegram:${ctx.chat.id}`;
    try {
      const message = args ? `/review ${args}` : "/review";
      const response = await agent.chat(chatId, message);
      await sendLongMessage(ctx, response);
    } catch (err) {
      console.error("Error in /review:", err);
      if (isRateLimitError(err)) {
        await ctx.reply(`Rate limited — please try again in ${formatRateLimitWait(err)}.`);
      } else {
        await ctx.reply("Sorry, something went wrong reviewing your session. Please try again.");
      }
    }
  });

  bot.command("version", async (ctx) => {
    await ctx.reply(`${binary.displayName} v${getCurrentVersion(binary.binaryName)}`);
  });

  bot.command("whatsnew", async (ctx) => {
    await ctx.reply("Fetching release notes...");
    try {
      const info = await checkForUpdate(binary.binaryName);
      if (!info) {
        await ctx.reply("Couldn't reach npm to check the latest version. Try again later.");
        return;
      }
      const message = await buildWhatsNewMessage(binary.binaryName, info);
      await sendLongMessage(ctx, message);
    } catch (err) {
      console.error("Error in /whatsnew:", err);
      await ctx.reply("Sorry, couldn't fetch release notes. Please try again.");
    }
  });

  bot.command("update", async (ctx) => {
    await ctx.reply("Checking for updates...");
    let latest: string | undefined;
    try {
      const info = await checkForUpdate(binary.binaryName);
      if (!info) {
        await ctx.reply("Could not check for updates. Try again later.");
        return;
      }
      if (!info.updateAvailable) {
        await ctx.reply(`You're on the latest version (${info.current}).`);
        return;
      }
      latest = info.latest;
      await ctx.reply(`Updating ${info.current} → ${info.latest}...\nThe bot will stop after installation. Run \`${binary.binaryName}\` to start it again.`);
      // Stop polling first so Telegram commits the /update offset — otherwise
      // Telegram re-sends /update on next startup and we loop forever.
      void bot.stop().then(() => selfUpdate(binary.binaryName, info.latest));
    } catch (err) {
      console.error("Error in /update:", err);
      await ctx.reply(
        `Update failed. Please run \`npm install -g ${binary.binaryName}@${latest ?? "latest"} --ignore-scripts\` manually.`,
      );
    }
  });

  // ── Free-form chat ──────────────────────────────────────────────────────

  bot.on("message:text", async (ctx) => {
    const chatId = `telegram:${ctx.chat.id}`;

    // Welcome newcomers on their very first message. `greeted` is in-memory,
    // so after a process restart we consult the on-disk session to tell
    // returning users from true newcomers.
    if (!greeted.has(ctx.chat.id)) {
      greeted.add(ctx.chat.id);
      if (!agent.hasSession(chatId)) {
        await ctx.reply(WELCOME_MESSAGE);
      }
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

export function markdownToTelegramHtml(md: string): string {
  // Telegram has no table primitive. Extract tables first so the bullet-point
  // regex below doesn't mangle their leading `|`, then restore as <pre> blocks.
  const { text, tables } = extractTables(md);

  // Escape the raw source BEFORE any markdown conversion so the only real tags
  // in the output are the ones this converter emits. Literal HTML in the LLM
  // output (which can echo attacker-influenced intervals.icu text) must render
  // as text, never as markup. Table cells are escaped inside renderTableAsPre.
  let html = escapeHtmlText(text);

  // Headers: ### Title → <b>Title</b>
  html = html.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");

  // Bold: **text** → <b>text</b>
  html = html.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");

  // Italic: *text* or _text_ → <i>text</i>
  html = html.replace(/(?<!\w)\*([^*]+?)\*(?!\w)/g, "<i>$1</i>");
  html = html.replace(/(?<!\w)_([^_]+?)_(?!\w)/g, "<i>$1</i>");

  // Code blocks: ```...``` → <pre>...</pre> (must run before inline-code, otherwise the
  // single-backtick regex eats pairs of fence backticks and breaks the block).
  html = html.replace(/```[\w]*\n?([\s\S]*?)```/g, "<pre>$1</pre>");

  // Inline code: `text` → <code>text</code>
  html = html.replace(/`([^`]+?)`/g, "<code>$1</code>");

  // Strikethrough: ~~text~~ → <s>text</s>
  html = html.replace(/~~(.+?)~~/g, "<s>$1</s>");

  // Bullet points: - item → • item
  html = html.replace(/^[-*]\s+/gm, "• ");

  return html.replace(/\[\[__TBL_(\d+)__\]\]/g, (_, idx) => tables[Number(idx)] ?? "");
}

const TABLE_SEPARATOR_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/;

function isTableRow(line: string | undefined): boolean {
  if (!line) return false;
  const t = line.trim();
  return t.startsWith("|") && t.endsWith("|") && t.length > 1;
}

function parseTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((s) => s.trim());
}

function extractTables(md: string): { text: string; tables: string[] } {
  const lines = md.split("\n");
  const tables: string[] = [];
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const next = lines[i + 1];
    if (isTableRow(lines[i]) && next !== undefined && TABLE_SEPARATOR_RE.test(next)) {
      const header = parseTableRow(lines[i]);
      const rows: string[][] = [];
      let j = i + 2;
      while (j < lines.length && isTableRow(lines[j])) {
        rows.push(parseTableRow(lines[j]));
        j++;
      }
      out.push(`[[__TBL_${tables.length}__]]`);
      tables.push(renderTableAsPre(header, rows));
      i = j;
    } else {
      out.push(lines[i]);
      i++;
    }
  }
  return { text: out.join("\n"), tables };
}

function renderTableAsPre(header: string[], rows: string[][]): string {
  const cols = Math.max(header.length, ...rows.map((r) => r.length));
  const widths: number[] = [];
  for (let c = 0; c < cols; c++) {
    let w = (header[c] ?? "").length;
    for (const r of rows) w = Math.max(w, (r[c] ?? "").length);
    widths.push(w);
  }
  const fmt = (r: string[]) =>
    Array.from({ length: cols }, (_, c) => (r[c] ?? "").padEnd(widths[c])).join("  ").trimEnd();
  const text = [fmt(header), ...rows.map(fmt)].map(escapeHtmlText).join("\n");
  return `<pre>${text}</pre>`;
}

// ============================================================================
// SEND WITH CHUNKING
// ============================================================================

const TELEGRAM_MAX_LENGTH = 4096;
const PRE_OPEN = "<pre>";
const PRE_CLOSE = "</pre>";
const PRE_OVERHEAD = PRE_OPEN.length + PRE_CLOSE.length;

type RenderUnit = { kind: "line"; text: string } | { kind: "pre"; text: string };

// Group multi-line <pre> blocks so the chunker treats each as one indivisible unit
// (Telegram rejects chunks with unmatched <pre>/</pre>).
function tokenizeHtml(html: string): RenderUnit[] {
  const units: RenderUnit[] = [];
  const lines = html.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const openIdx = line.indexOf(PRE_OPEN);
    const closeOnSame = openIdx >= 0 ? line.indexOf(PRE_CLOSE, openIdx) : -1;
    if (openIdx >= 0 && closeOnSame < 0) {
      let j = i + 1;
      while (j < lines.length && !lines[j].includes(PRE_CLOSE)) j++;
      if (j < lines.length) {
        units.push({ kind: "pre", text: lines.slice(i, j + 1).join("\n") });
        i = j + 1;
        continue;
      }
      // Unclosed <pre> — fall through and treat each line individually.
    }
    units.push({ kind: "line", text: line });
    i++;
  }
  return units;
}

// Split a <pre> block whose own length exceeds maxLen into multiple wrapped <pre> chunks
// so each chunk Telegram receives has a matching open/close tag.
function splitPreBlock(block: string, maxLen: number): string[] {
  const inner = block.replace(/^<pre>/, "").replace(/<\/pre>$/, "");
  const out: string[] = [];
  let current = "";
  for (const row of inner.split("\n")) {
    const candidate = current ? `${current}\n${row}` : row;
    if (candidate.length + PRE_OVERHEAD <= maxLen) {
      current = candidate;
      continue;
    }
    if (current) {
      out.push(`${PRE_OPEN}${current}${PRE_CLOSE}`);
      current = row;
      if (current.length + PRE_OVERHEAD <= maxLen) continue;
    }
    // Single row alone exceeds the budget — hard-split, wrap each piece.
    const sliceMax = Math.max(1, maxLen - PRE_OVERHEAD);
    for (let k = 0; k < row.length; k += sliceMax) {
      out.push(`${PRE_OPEN}${row.slice(k, k + sliceMax)}${PRE_CLOSE}`);
    }
    current = "";
  }
  if (current) out.push(`${PRE_OPEN}${current}${PRE_CLOSE}`);
  return out;
}

export function chunkHtml(html: string, maxLen: number = TELEGRAM_MAX_LENGTH): string[] {
  if (html.length <= maxLen) return [html];

  const chunks: string[] = [];
  let current = "";
  const flush = () => {
    if (current) {
      chunks.push(current);
      current = "";
    }
  };

  for (const unit of tokenizeHtml(html)) {
    const text = unit.text;
    const joinCost = current ? 1 : 0;

    if (current.length + text.length + joinCost <= maxLen) {
      current += (current ? "\n" : "") + text;
      continue;
    }

    flush();

    if (text.length <= maxLen) {
      current = text;
      continue;
    }

    if (unit.kind === "pre") {
      chunks.push(...splitPreBlock(text, maxLen));
    } else {
      for (let i = 0; i < text.length; i += maxLen) {
        chunks.push(text.slice(i, i + maxLen));
      }
    }
  }

  flush();
  return chunks;
}

function isTelegramParseError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("can't parse entities");
}

export async function sendLongMessage(
  ctx: { reply: (text: string, options?: Record<string, unknown>) => Promise<unknown> },
  text: string,
): Promise<void> {
  const html = markdownToTelegramHtml(text);
  for (const chunk of chunkHtml(html)) {
    try {
      await ctx.reply(chunk, { parse_mode: "HTML" });
    } catch (err) {
      if (!isTelegramParseError(err)) throw err;
      // Log the message only — a grammY error object carries the request
      // payload, i.e. the athlete's reply text, which must stay out of logs.
      console.error(
        "Telegram rejected HTML chunk; resending as plain text:",
        err instanceof Error ? err.message : String(err),
      );
      await ctx.reply(chunk);
    }
  }
}

// ============================================================================
// STARTUP UPDATE NOTIFICATION
// ============================================================================

export async function notifyUpdate(bot: Bot, dataDir: string, binary: BinaryConfig): Promise<void> {
  try {
    const info = await checkForUpdate(binary.binaryName);
    if (!info?.updateAvailable) return;

    if (getLastNotifiedVersion(dataDir) === info.latest) return;

    // Filter the broadcast list against the current allowlist. Pre-update
    // strangers' chat-ids may still be in getKnownTelegramChatIds (their session
    // files persist on disk) but must NOT receive update notifications.
    const allowed = loadAllowedSenders(dataDir);
    const allowSet = new Set(allowed.allowFrom);
    const knownChats = getKnownTelegramChatIds(dataDir);
    const chatIds =
      allowed.dmPolicy === "open" ? knownChats : knownChats.filter((id) => allowSet.has(id));
    const message = `Update available: ${info.current} → ${info.latest}\nSend /whatsnew to see what changed, /update to install.`;

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
