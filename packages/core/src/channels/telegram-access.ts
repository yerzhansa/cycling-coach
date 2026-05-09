import type { Context, MiddlewareFn } from "grammy";
import { loadAllowedSenders, type AllowedSenders } from "./allowed-senders.js";
import { escapeHtmlAttr } from "./html-escape.js";

export type { DmPolicy } from "./allowed-senders.js";

export interface AuthDecision {
  allow: boolean;
  pairingChallenge?: string;
}

export function buildPairingChallenge(
  senderId: string | number,
  senderName: string | undefined,
  binaryName: string,
): string {
  const idStr = String(senderId);
  const safeName = senderName ? escapeHtmlAttr(senderName) : "there";
  const safeBin = escapeHtmlAttr(binaryName);
  // Include the literal CLI command for the operator AND the "ask the bot owner"
  // fallback. Operators copy-paste from their own message to authorize themselves;
  // strangers see they cannot self-authorize.
  return [
    `<b>This bot is private.</b>`,
    ``,
    `Hi ${safeName} — your Telegram user ID is <code>${escapeHtmlAttr(idStr)}</code>.`,
    ``,
    `<b>If you're the bot owner:</b> run`,
    `<pre>${safeBin} add-sender ${escapeHtmlAttr(idStr)}</pre>`,
    `from a shell on the host where the bot runs, then send your message again.`,
    ``,
    `Otherwise: ask the bot owner to authorize your user ID.`,
  ].join("\n");
}

export function evaluateAccess(ctx: Context, allowed: AllowedSenders): AuthDecision {
  if (ctx.chat?.type !== "private") return { allow: false };
  const fromId = ctx.from?.id;
  if (fromId === undefined) return { allow: false };
  if (typeof fromId !== "number") return { allow: false };

  const senderId = String(fromId);
  if (allowed.allowFrom.includes(senderId)) return { allow: true };
  if (allowed.dmPolicy === "open") return { allow: true };

  // Sender not allowlisted. Pairing mode → return challenge; allowlist → silent drop.
  if (allowed.dmPolicy === "pairing") {
    // Challenge body is constructed by the caller (createAuthMiddleware) so it can
    // pass through binaryName / senderName / HTML escaping.
    return { allow: false, pairingChallenge: senderId };
  }
  return { allow: false };
}

export interface CreateAuthMiddlewareOpts {
  dataDir: string;
  binaryName: string;
  challengeRateLimit: Map<string, number>;
  challengeMinIntervalMs: number;
}

const RATE_LIMIT_MAX_ENTRIES = 1000;

function recordChallenge(map: Map<string, number>, senderId: string, now: number): void {
  if (map.has(senderId)) map.delete(senderId); // bump to MRU position
  map.set(senderId, now);
  while (map.size > RATE_LIMIT_MAX_ENTRIES) {
    const oldestKey = map.keys().next().value;
    if (oldestKey === undefined) break;
    map.delete(oldestKey);
  }
}

export function createAuthMiddleware(opts: CreateAuthMiddlewareOpts): MiddlewareFn<Context> {
  return async (ctx, next) => {
    try {
      const allowed = loadAllowedSenders(opts.dataDir);
      const decision = evaluateAccess(ctx, allowed);
      if (decision.allow) {
        await next();
        return;
      }
      // Drop. Optionally reply with pairing-challenge (rate-limited per-sender).
      if (decision.pairingChallenge) {
        const senderId = decision.pairingChallenge;
        const now = Date.now();
        const last = opts.challengeRateLimit.get(senderId) ?? 0;
        if (now - last < opts.challengeMinIntervalMs) return;
        recordChallenge(opts.challengeRateLimit, senderId, now);
        const html = buildPairingChallenge(
          senderId,
          ctx.from?.first_name,
          opts.binaryName,
        );
        await ctx.reply(html, { parse_mode: "HTML" });
      }
    } catch (err) {
      // Fail closed: log to stderr, drop the update without calling next().
      console.error(
        `[security] middleware error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };
}
