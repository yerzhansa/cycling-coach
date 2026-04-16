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
