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
  isManagedDeploy,
  MANAGED_DEPLOY_UPDATE_NOTICE,
  setLastNotifiedVersion,
} from "../updater.js";
import { buildWhatsNewMessage } from "../release-notes.js";
import { createAuthMiddleware } from "./telegram-access.js";
import { loadAllowedSenders, loadAllowedSendersWithSource } from "./allowed-senders.js";
import { escapeHtmlText } from "./html-escape.js";
import type { ReferenceServices } from "../reference/services.js";
import { resolveRunningCs, type ResolvedCs } from "../reference/cs-resolution.js";
import { formatSyncReply } from "../reference/sync/format-sync-reply.js";
import { formatSnapshotRaw } from "../reference/sync/snapshot-debug.js";
import { sendSnapshotOutput } from "../reference/sync/send-snapshot.js";
import { createSubsystemLogger } from "../logging/index.js";

function formatRateLimitWait(err: unknown): string {
  const ms = extractRetryAfterMs(err);
  if (!ms) return "about a minute";
  const secs = Math.ceil(ms / 1000);
  if (secs < 60) return `~${secs} seconds`;
  return `~${Math.ceil(secs / 60)} minute${Math.ceil(secs / 60) > 1 ? "s" : ""}`;
}

// Upper bound on how long /update waits for in-flight turns to finish before
// self-updating. A hung turn must never wedge the update, so the drain races a
// timeout.
const UPDATE_DRAIN_TIMEOUT_MS = 10_000;

function drainBounded(drain: () => Promise<void>, timeoutMs: number): Promise<void> {
  return Promise.race([
    drain(),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs).unref?.()),
  ]);
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

const RESET_CAVEAT_NOTE =
  "Note: I couldn't fully reset our previous session, so some earlier context may still apply.";

const SNAPSHOT_HELP =
  "/snapshot raw [section]    — dump pre-curation latest.json (or one section)\n" +
  "/snapshot help             — show this list\n\n" +
  "Future variants of /snapshot will surface metrics, activities, wellness,\n" +
  "intervals, routes, history, FTP, and validation cuts. For now, only\n" +
  "/snapshot raw is wired.";

// Descriptions mirror the command one-liners in WELCOME_MESSAGE so the native
// "/" menu and the welcome card never drift. /sync is conditional on the same
// reference predicate the command registration uses; /snapshot is excluded by
// construction (operator-only debug). /start is included as an athlete command.
function buildCommandMenu(reference?: ReferenceServices): { command: string; description: string }[] {
  const menu = [
    { command: "start", description: "Start a fresh session" },
    { command: "plan", description: "Generate a training plan" },
    { command: "workout", description: "Get today's workout" },
    { command: "status", description: "Check current fitness, fatigue, and form" },
    { command: "review", description: "Review your last session" },
  ];
  if (reference !== undefined) {
    menu.push({ command: "sync", description: "Force-refresh training data from intervals.icu" });
  }
  menu.push(
    { command: "version", description: "Show current version" },
    { command: "whatsnew", description: "See what changed in the latest version" },
    { command: "update", description: "Check for and install updates" },
  );
  return menu;
}

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

export interface TelegramBotHandle {
  bot: Bot;
  drainPending: () => Promise<void>;
}

export function createTelegramBot(
  token: string,
  agent: CoachAgent,
  binary: BinaryConfig,
  dataDir: string,
  reference?: ReferenceServices,
): TelegramBotHandle {
  logSecurityStartup(dataDir, binary.binaryName);
  const bot = createSecuredBot({ token, binary, dataDir });
  const log = createSubsystemLogger("telegram", dataDir);
  const greeted = new Set<number>();

  // Fire-and-forget turn dispatch. Telegram handlers spawn the LLM turn on a
  // tracked task and return immediately so grammY's sequential update loop is
  // never blocked by a long turn. The task owns its user-facing error reply; the
  // outer catch here is the last-resort net so a throw inside the reply path can
  // never escape as an unhandled rejection. Per-chat ordering is preserved by the
  // existing per-chat session lock inside agent.chat, not by any lock here.
  const pending = new Set<Promise<void>>();
  const dispatch = (work: () => Promise<void>): void => {
    const task = (async () => {
      try {
        await work();
      } catch (err) {
        log.error("dispatch_failed", err, {});
      }
    })();
    pending.add(task);
    void task.finally(() => pending.delete(task));
  };
  const drainPending = (): Promise<void> => Promise.all(pending).then(() => undefined);

  void bot.api.setMyCommands(buildCommandMenu(reference)).catch((err) => {
    log.error("set_commands_failed", err, {});
  });

  // Resolve the running CS anchor once per turn from the latest synced profile so
  // calculate_zones reads the athlete's real critical speed instead of an LLM
  // guess. Returns undefined — leaving the tool on its LLM-supplied param — when no
  // reference sync is wired; resolveRunningCs itself returns null for cycling,
  // pre-sync, or a profile with no run-family row.
  const turnDeps = (): { resolvedCs: ResolvedCs | null } | undefined =>
    reference !== undefined ? { resolvedCs: resolveRunningCs(reference.loadLatest()) } : undefined;

  // Shared turn skeleton: every chat-bearing handler captures its deps/message
  // synchronously, then hands the LLM turn here to run on the fire-and-forget
  // task. The only per-handler differences are the user-facing strings, the log
  // command name, and (for the text chat handler) the rate-limited reply wording,
  // all passed in rather than re-templated so the handlers stay byte-identical.
  function runTurn(opts: {
    ctx: { reply: (text: string, options?: Record<string, unknown>) => Promise<unknown> };
    command: string;
    chatId: string;
    message: string;
    deps: ReturnType<typeof turnDeps>;
    genericReply: string;
    rateLimitReply?: (err: unknown) => string;
  }): void {
    dispatch(async () => {
      try {
        const response = await agent.chat(opts.chatId, opts.message, opts.deps);
        await sendLongMessage(opts.ctx, response);
      } catch (err) {
        log.error("command_failed", err, { command: opts.command, chatId: opts.chatId });
        if (isRateLimitError(err)) {
          const reply = opts.rateLimitReply
            ? opts.rateLimitReply(err)
            : `Rate limited — please try again in ${formatRateLimitWait(err)}.`;
          await opts.ctx.reply(reply);
        } else {
          await opts.ctx.reply(opts.genericReply);
        }
      }
    });
  }

  // ── Commands ────────────────────────────────────────────────────────────

  bot.command("start", async (ctx) => {
    greeted.add(ctx.chat.id);
    let memoryFlushed = true;
    try {
      ({ memoryFlushed } = await agent.resetSession(`telegram:${ctx.chat.id}`));
    } catch (err) {
      log.error("command_failed", err, { command: "start", chatId: `telegram:${ctx.chat.id}` });
      await ctx.reply(
        "Something went wrong resetting your session — your history is untouched. Please try /start again.",
      );
      return;
    }
    await ctx.reply(
      memoryFlushed ? WELCOME_MESSAGE : `${WELCOME_MESSAGE}\n\n${RESET_CAVEAT_NOTE}`,
    );
  });

  bot.command("plan", async (ctx) => {
    await ctx.reply("Analyzing your data and building a plan...");
    const chatId = `telegram:${ctx.chat.id}`;
    const deps = turnDeps();
    runTurn({
      ctx,
      command: "plan",
      chatId,
      message: "/plan",
      deps,
      genericReply: "Sorry, something went wrong generating your plan. Please try again.",
    });
  });

  bot.command("workout", async (ctx) => {
    await ctx.reply("Checking your form and plan...");
    const chatId = `telegram:${ctx.chat.id}`;
    const deps = turnDeps();
    runTurn({
      ctx,
      command: "workout",
      chatId,
      message: "/workout",
      deps,
      genericReply: "Sorry, something went wrong. Please try again.",
    });
  });

  bot.command("status", async (ctx) => {
    await ctx.reply("Fetching your fitness data...");
    const chatId = `telegram:${ctx.chat.id}`;
    const deps = turnDeps();
    runTurn({
      ctx,
      command: "status",
      chatId,
      message: "/status",
      deps,
      genericReply: "Sorry, something went wrong. Please try again.",
    });
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
        log.error("command_failed", err, { command: "sync", chatId: `telegram:${ctx.chat.id}` });
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
            reply: (text) => sendLongMessage(ctx, text) as Promise<unknown>,
            sendDocument: (buffer, filename) =>
              ctx.replyWithDocument(new InputFile(buffer, filename)) as Promise<unknown>,
          });
        } catch (err) {
          log.error("command_failed", err, { command: "snapshot", chatId: `telegram:${ctx.chat.id}` });
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
    const deps = turnDeps();
    const message = args ? `/review ${args}` : "/review";
    runTurn({
      ctx,
      command: "review",
      chatId,
      message,
      deps,
      genericReply: "Sorry, something went wrong reviewing your session. Please try again.",
    });
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
      log.error("command_failed", err, { command: "whatsnew", chatId: `telegram:${ctx.chat.id}` });
      await ctx.reply("Sorry, couldn't fetch release notes. Please try again.");
    }
  });

  bot.command("update", async (ctx) => {
    if (isManagedDeploy()) {
      await ctx.reply(MANAGED_DEPLOY_UPDATE_NOTICE);
      return;
    }

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
      // Telegram re-sends /update on next startup and we loop forever — then let
      // in-flight turns finish (bounded) so a self-update never drops a reply the
      // athlete is already waiting on.
      void bot
        .stop()
        .then(() => drainBounded(drainPending, UPDATE_DRAIN_TIMEOUT_MS))
        .then(() => selfUpdate(binary.binaryName, info.latest));
    } catch (err) {
      log.error("command_failed", err, { command: "update", chatId: `telegram:${ctx.chat.id}` });
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

    const text = ctx.message.text;
    const deps = turnDeps();
    runTurn({
      ctx,
      command: "chat",
      chatId,
      message: text,
      deps,
      genericReply: "Sorry, something went wrong. Please try again.",
      rateLimitReply: (err) =>
        `Your message was not processed (rate limited). Please wait ${formatRateLimitWait(err)} and resend:\n\n"${text.slice(0, 200)}"`,
    });
  });

  return { bot, drainPending };
}

// ============================================================================
// MARKDOWN → TELEGRAM HTML
// ============================================================================

export function markdownToTelegramHtml(md: string): string {
  // Telegram has no table primitive. Extract tables first so the bullet-point
  // regex below doesn't mangle their leading `|`, then restore as <pre> blocks.
  const { text: noTables, tables } = extractTables(md);

  // Extract fenced code blocks from the RAW (table-stripped) markdown BEFORE
  // escaping, exactly as extractTables does. This preserves the fence body
  // byte-for-byte through the regex passes (no header/bold/italic/bullet
  // transform reaches inside) and restores it as an escaped <pre> at the end,
  // keeping the escape-first security property intact.
  const { text, fences } = extractFences(noTables);

  // Escape the raw source BEFORE any markdown conversion so the only real tags
  // in the output are the ones this converter emits. Literal HTML in the LLM
  // output (which can echo attacker-influenced intervals.icu text) must render
  // as text, never as markup. Table cells are escaped inside renderTableAsPre;
  // fence bodies are escaped on restore below.
  let html = escapeHtmlText(text);

  // Headers: ### Title → <b>Title</b>
  html = html.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");

  // Bold: **text** → <b>text</b>
  html = html.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");

  // Italic: *text* or _text_ → <i>text</i>. A space (or another `*`) adjacent to
  // either delimiter disqualifies the match, so interval math like
  // `do 3 * 8 reps then 2 * 20min` keeps its literal `*` and emits no <i>.
  html = html.replace(/(?<![\w*])\*(?![\s*])([^*\n]+?)(?<![\s*])\*(?![\w*])/g, "<i>$1</i>");
  html = html.replace(/(?<!\w)_([^_]+?)_(?!\w)/g, "<i>$1</i>");

  // Links: [text](http(s)://url) → <a href="url">text</a>. Runs on the
  // post-escape html string, so the link text is already escaped; the url is
  // captured from this same (escaped) string and only attribute-quote-escaped —
  // re-running escapeHtmlText would double-escape an already-escaped `&` in a
  // multi-param query string. http/https only; other schemes stay literal. The
  // URL allows one level of balanced parens so Wikipedia-style URLs like
  // `…/Foo_(bar)` keep their closing paren instead of truncating at it.
  html = html.replace(
    /\[([^\]]+)\]\((https?:\/\/(?:[^\s()]|\([^\s()]*\))+)\)/g,
    (_, label: string, url: string) => `<a href="${escapeHtmlAttrPreEscaped(url)}">${label}</a>`,
  );

  // Inline code: `text` → <code>text</code>
  html = html.replace(/`([^`]+?)`/g, "<code>$1</code>");

  // Strikethrough: ~~text~~ → <s>text</s>
  html = html.replace(/~~(.+?)~~/g, "<s>$1</s>");

  // Bullet points: - item → • item
  html = html.replace(/^[-*]\s+/gm, "• ");

  html = html.replace(/\[\[__TBL_(\d+)__\]\]/g, (_, idx) => tables[Number(idx)] ?? "");
  return html.replace(
    /\[\[__FENCE_(\d+)__\]\]/g,
    (_, idx) => `<pre>${escapeHtmlText(fences[Number(idx)] ?? "")}</pre>`,
  );
}

// Quote/apostrophe-escape a URL that has ALREADY passed through escapeHtmlText
// (so `&`/`<`/`>` are entities). Only `"` and `'` remain to neutralize for an
// attribute context; escapeHtmlAttr would re-escape the entities' `&`.
function escapeHtmlAttrPreEscaped(s: string): string {
  return s.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const FENCE_RE = /```[^\n]*\n?([\s\S]*?)```/g;

// Mirror extractTables: walk the RAW markdown, replace each fenced code block
// with an inert placeholder (no `* _ ` # -` or leading `[-*]`, so no regex
// between extraction and restore touches it), and collect the raw fence body
// for escaped-<pre> restore at the end of markdownToTelegramHtml.
function extractFences(md: string): { text: string; fences: string[] } {
  const fences: string[] = [];
  const text = md.replace(FENCE_RE, (_, body: string) => {
    const idx = fences.length;
    fences.push(body);
    return `[[__FENCE_${idx}__]]`;
  });
  return { text, fences };
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
      chunks.push(...hardSplit(text, maxLen));
    }
  }

  flush();
  return chunks;
}

// Hard-split a single oversized line at a boundary that never bisects an HTML
// tag (`<…>`), an entity (`&…;`), or a UTF-16 surrogate pair, and never lands
// BETWEEN a converter tag's open and its close (which would leave a chunk with
// an unbalanced `<b>`/`<a>`/… — Telegram rejects it and forces the plain-text
// fallback). Scans back from the fixed offset to the last such safe cut; if none
// exists below maxLen the line is pathological (e.g. one >maxLen tag) and we fall
// back to the raw slice for that one piece to guarantee forward progress.
// (`<pre>` blocks never reach here; they are split by splitPreBlock.)
function hardSplit(text: string, maxLen: number): string[] {
  const out: string[] = [];
  let start = 0;
  while (text.length - start > maxLen) {
    let cut = start + maxLen;
    while (cut > start && !isSafeCut(text, start, cut)) cut--;
    if (cut === start) cut = start + maxLen; // pathological: no safe boundary
    out.push(text.slice(start, cut));
    start = cut;
  }
  out.push(text.slice(start));
  return out;
}

const INLINE_TAG_RE = /<(\/?)(b|i|s|u|code|a)\b[^>]*>/g;

// True when cutting at `i` would leave an inline converter tag opened within
// [start, i) still unclosed at `i` — i.e. the cut falls between an open tag and
// its matching close, which yields an unbalanced chunk.
function cutSplitsOpenTag(text: string, start: number, i: number): boolean {
  const stack: string[] = [];
  for (const m of text.slice(start, i).matchAll(INLINE_TAG_RE)) {
    if (m[1] === "/") {
      const k = stack.lastIndexOf(m[2]);
      if (k >= 0) stack.splice(k, 1);
    } else {
      stack.push(m[2]);
    }
  }
  return stack.length > 0;
}

// A cut at index `i` (split into [start..i) and [i..]) is safe when it does not
// land inside an open `<…>` tag, inside an unterminated `&…;` entity, between the
// two halves of a surrogate pair, or between a converter tag's open and close.
function isSafeCut(text: string, start: number, i: number): boolean {
  const prev = text.charCodeAt(i - 1);
  if (prev >= 0xd800 && prev <= 0xdbff) return false; // high surrogate before cut

  // Inside a tag if the nearest unescaped `<`/`>` scanning back is a `<`.
  const lt = text.lastIndexOf("<", i - 1);
  const gt = text.lastIndexOf(">", i - 1);
  if (lt > gt) return false;

  // Inside an entity if the nearest `&` scanning back has no terminating `;`
  // before the cut and is close enough to still be an open entity run.
  const amp = text.lastIndexOf("&", i - 1);
  if (amp >= 0) {
    const semi = text.indexOf(";", amp);
    if (semi < 0 || semi >= i) {
      // No `;` yet; only treat as an open entity if the run so far is entity-ish
      // (no whitespace/`<`/`&`), otherwise a bare `&` is just literal text.
      const run = text.slice(amp + 1, i);
      if (/^[a-zA-Z0-9#]*$/.test(run)) return false;
    }
  }

  if (cutSplitsOpenTag(text, start, i)) return false;
  return true;
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
    // Telegram rejects an empty message (400: message text is empty), and an
    // empty chunk carries nothing for the athlete anyway — skip it so ctx.reply
    // is never called with empty/whitespace-only text.
    if (chunk.trim() === "") continue;
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
      // Resend human-readable source, not the rejected HTML. Strip the converter
      // tags and invert the (trivially invertible) HTML escape so the athlete
      // sees clean text — never tag soup or double-escaped entities.
      const plain = htmlChunkToPlainText(chunk);
      if (plain.trim() === "") continue;
      await ctx.reply(plain);
    }
  }
}

// Turn a rejected HTML chunk back into readable plain text for the no-parse-mode
// fallback: drop the converter tags this module emits, then invert escapeHtmlText
// (`&lt;`→`<`, `&gt;`→`>`, and `&amp;`→`&` LAST so `&amp;lt;` round-trips to
// `&lt;`). The output carries no tags and no double-escaped entities.
function htmlChunkToPlainText(chunk: string): string {
  return chunk
    .replace(/<\/?(?:b|i|s|u|pre|code)>/g, "")
    .replace(/<a href="[^"]*">/g, "")
    .replace(/<\/a>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
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
    const updateInstruction = isManagedDeploy()
      ? `Send /whatsnew to see what changed. ${MANAGED_DEPLOY_UPDATE_NOTICE}`
      : "Send /whatsnew to see what changed, /update to install.";
    const message = `Update available: ${info.current} → ${info.latest}\n${updateInstruction}\n\nWant the bot running 24/7 without keeping your computer on? Deploy the Railway template: https://railway.com/deploy/cycling-coach\n\nTag or DM me at x.com/yerzhansa with feedback, feature requests, or bugs — help shape what's next.`;

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
