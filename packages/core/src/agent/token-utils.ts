import type { ModelMessage } from "ai";
import { APICallError } from "@ai-sdk/provider";

export const CHARS_PER_TOKEN = 4;
export const SAFETY_MARGIN = 1.2;
export const RESERVE_TOKENS = 20_000;
export const MIN_PROMPT_BUDGET_TOKENS = 8000;
export const TIMEOUT_COMPACTION_THRESHOLD = 0.65;
export const SUMMARIZATION_OVERHEAD_TOKENS = 4096;

export function messageText(m: ModelMessage): string {
  return typeof m.content === "string" ? m.content : "";
}

export function estimateTokens(text: string): number {
  return Math.ceil((text.length / CHARS_PER_TOKEN) * SAFETY_MARGIN);
}

export function estimateMessagesTokens(messages: ModelMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(messageText(m)), 0);
}

export function computeHistoryTokenBudget(params: {
  contextWindowTokens: number;
  systemPrompt: string;
  budgetRatio: number;
}): number {
  const raw =
    Math.floor(params.contextWindowTokens * params.budgetRatio) -
    estimateTokens(params.systemPrompt) -
    RESERVE_TOKENS;
  return Math.max(raw, MIN_PROMPT_BUDGET_TOKENS);
}

export function shouldCompact(params: {
  messages: ModelMessage[];
  systemPrompt: string;
  contextWindowTokens: number;
}): boolean {
  const estimated =
    estimateMessagesTokens(params.messages) + estimateTokens(params.systemPrompt);
  const budget = params.contextWindowTokens - RESERVE_TOKENS;
  return estimated > budget;
}

export function isContextOverflowError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("context_length") ||
    msg.includes("context window") ||
    msg.includes("maximum context") ||
    msg.includes("token limit") ||
    msg.includes("too many tokens") ||
    msg.includes("content_too_large")
  );
}

export function isTimeoutError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("deadline exceeded") ||
    err.name === "TimeoutError" ||
    ("code" in err && (err as { code: string }).code === "ETIMEDOUT")
  );
}

export function isRateLimitError(err: unknown): boolean {
  if (APICallError.isInstance(err)) {
    return err.statusCode === 429;
  }
  // Fallback for non-SDK errors
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return msg.includes("rate limit") || msg.includes("too many requests");
}

export type FailureReason =
  | "overflow"
  | "timeout"
  | "rate_limit"
  | "server_error"
  | "network"
  | "auth"
  | "invalid_request"
  | "unknown";

const NETWORK_ERROR_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN"]);

export function isServerError(err: unknown): boolean {
  if (APICallError.isInstance(err)) {
    return [500, 502, 503, 504, 529].includes(err.statusCode ?? -1);
  }
  // A codex 5xx is normalized into a plain Error with this name so both
  // providers route the server-error class identically.
  return err instanceof Error && err.name === "ServerError";
}

interface Caused {
  code?: unknown;
  cause?: unknown;
}

export function isNetworkError(err: unknown): boolean {
  // undici hides the conn code on the wrapped inner error, so chase the chain.
  let n = err as Caused | null | undefined;
  const seen = new Set<unknown>();
  for (let d = 0; d < 5 && n != null && !seen.has(n); d++, n = n.cause as Caused | null) {
    seen.add(n);
    if (typeof n.code === "string" && NETWORK_ERROR_CODES.has(n.code)) return true;
  }
  return false;
}

export function isAuthError(err: unknown): boolean {
  return APICallError.isInstance(err) && (err.statusCode === 401 || err.statusCode === 403);
}

export function isInvalidRequestError(err: unknown): boolean {
  return APICallError.isInstance(err) && err.statusCode === 400;
}

export function classifyFailure(err: unknown): FailureReason {
  if (isContextOverflowError(err)) return "overflow";
  if (isTimeoutError(err)) return "timeout";
  if (isRateLimitError(err)) return "rate_limit";
  if (isServerError(err)) return "server_error";
  if (isNetworkError(err)) return "network";
  if (isAuthError(err)) return "auth";
  if (isInvalidRequestError(err)) return "invalid_request";
  return "unknown";
}

export function extractRetryAfterMs(err: unknown): number | null {
  if (!APICallError.isInstance(err)) return null;
  const headers = err.responseHeaders;
  if (!headers) return null;

  // Prefer precise ms header (OpenAI convention)
  const msHeader = headers["retry-after-ms"];
  if (msHeader) {
    const ms = parseInt(msHeader, 10);
    if (Number.isFinite(ms) && ms > 0) return ms;
  }

  // Standard retry-after header (seconds)
  const retryAfter = headers["retry-after"];
  if (retryAfter) {
    const secs = parseInt(retryAfter, 10);
    if (Number.isFinite(secs) && secs > 0) return secs * 1000;
  }

  return null;
}
