import type { FinishReason, LanguageModelUsage, ModelMessage } from "ai";
import { APICallError } from "@ai-sdk/provider";

export const CHARS_PER_TOKEN = 4;
export const SAFETY_MARGIN = 1.2;
export const RESERVE_TOKENS = 20_000;
export const MIN_PROMPT_BUDGET_TOKENS = 8000;
export const TIMEOUT_COMPACTION_THRESHOLD = 0.65;
export const SUMMARIZATION_OVERHEAD_TOKENS = 4096;

// The provider context window can be 1M+ tokens, which would let history budget
// math build enormous prompts even when product cost/latency want earlier
// compaction. Cap the ESTIMATOR window (never the provider truth) so budget math
// uses min(providerWindow, 200k). Smaller provider windows apply unchanged.
export const MAX_EFFECTIVE_WINDOW_ESTIMATOR_TOKENS = 200_000;

export function effectiveEstimatorWindowTokens(contextWindowTokens: number): number {
  return Math.min(contextWindowTokens, MAX_EFFECTIVE_WINDOW_ESTIMATOR_TOKENS);
}

export function messageText(m: ModelMessage): string {
  const content = m.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  // Non-string content used to estimate as zero, silently undercounting a
  // part-array message (tool outputs, structured parts) toward the context
  // budget. Take text parts verbatim and JSON-serialize other structured parts
  // so their size is counted rather than dropped.
  let out = "";
  for (const part of content) {
    if (typeof part === "string") {
      out += part;
    } else if (part !== null && typeof part === "object") {
      const text = (part as { text?: unknown }).text;
      out += typeof text === "string" ? text : JSON.stringify(part);
    }
  }
  return out;
}

export function estimateTokens(text: string): number {
  return Math.ceil((text.length / CHARS_PER_TOKEN) * SAFETY_MARGIN);
}

export function estimateMessagesTokens(messages: ModelMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(messageText(m)), 0);
}

// Budget-check token estimate. When a provider usage anchor is available, the
// tokens the model already saw are anchored to the provider's real count (which
// tokenizes non-Latin text far more accurately than chars/4) and only messages
// appended since the anchor are char-estimated. The result is a safer,
// never-lower floor than the pure char estimate; it never replaces the raw
// provider context truth.
export function estimatePromptTokens(params: {
  messages: ModelMessage[];
  systemPrompt: string;
  // Final-step prompt token count from the provider — already includes the
  // system prompt, so the anchored branch must not add it again.
  lastUsageTokens?: number;
  messagesSinceUsageAnchor?: ModelMessage[];
}): number {
  const charEstimate =
    estimateMessagesTokens(params.messages) + estimateTokens(params.systemPrompt);
  if (params.lastUsageTokens === undefined || params.messagesSinceUsageAnchor === undefined) {
    return charEstimate;
  }
  const anchored =
    params.lastUsageTokens + estimateMessagesTokens(params.messagesSinceUsageAnchor);
  return Math.max(charEstimate, anchored);
}

export function computeHistoryTokenBudget(params: {
  contextWindowTokens: number;
  systemPrompt: string;
  budgetRatio: number;
}): number {
  const raw =
    Math.floor(effectiveEstimatorWindowTokens(params.contextWindowTokens) * params.budgetRatio) -
    estimateTokens(params.systemPrompt) -
    RESERVE_TOKENS;
  return Math.max(raw, MIN_PROMPT_BUDGET_TOKENS);
}

export function shouldCompact(params: {
  messages: ModelMessage[];
  systemPrompt: string;
  contextWindowTokens: number;
  lastUsageTokens?: number;
  messagesSinceUsageAnchor?: ModelMessage[];
}): boolean {
  const estimated = estimatePromptTokens(params);
  const budget = effectiveEstimatorWindowTokens(params.contextWindowTokens) - RESERVE_TOKENS;
  return estimated > budget;
}

const OVERFLOW_MESSAGE_PATTERNS = [
  "context_length",
  "context window",
  "maximum context",
  "token limit",
  "too many tokens",
  "content_too_large",
  "prompt is too long",
  "exceeds the maximum",
  "input token count",
] as const;

// A single OpenAI-family structured code; other providers signal overflow only
// in the message text, handled by the pattern list above.
const OVERFLOW_ERROR_CODES = new Set(["context_length_exceeded"]);

function matchesOverflowText(text: string): boolean {
  const lower = text.toLowerCase();
  return OVERFLOW_MESSAGE_PATTERNS.some((p) => lower.includes(p));
}

// A 400 is the only status that can carry a context-overflow invalid request;
// a generic 400 must stay invalid_request, so read the structured body rather
// than treating every 400 as overflow.
function apiCallOverflowSignal(err: APICallError): boolean {
  if (err.statusCode !== 400) return false;
  const data = err.data as
    | { error?: { code?: unknown; message?: unknown } }
    | undefined;
  const code = data?.error?.code;
  if (typeof code === "string" && OVERFLOW_ERROR_CODES.has(code)) return true;
  const bodyMessage = data?.error?.message;
  if (typeof bodyMessage === "string" && matchesOverflowText(bodyMessage)) return true;
  if (typeof err.responseBody === "string" && matchesOverflowText(err.responseBody)) return true;
  return false;
}

export function isContextOverflowError(err: unknown): boolean {
  // Codex-normalized overflow is authoritative (the bridge sets this name).
  if (err instanceof Error && err.name === "ContextOverflowError") return true;
  if (APICallError.isInstance(err) && apiCallOverflowSignal(err)) return true;
  if (!(err instanceof Error)) return false;
  return matchesOverflowText(err.message);
}

// A successful generation whose finishReason is "length" is normally plain
// output-length truncation. But when the prompt alone already filled (or
// exceeded) the real provider window, that same "length" stop means the context
// window was exhausted, not that the model wrote a long answer. Detect the
// latter from usage so it can be routed to compaction rescue instead of being
// persisted as a truncated reply. Uses the RAW provider window (truth), not the
// estimator cap.
export function isWindowExceededFinish(params: {
  finishReason: FinishReason;
  usage: LanguageModelUsage | undefined;
  contextWindowTokens: number;
}): boolean {
  if (params.finishReason !== "length") return false;
  const inputTokens = params.usage?.inputTokens;
  if (typeof inputTokens !== "number" || !Number.isFinite(inputTokens)) return false;
  return inputTokens >= params.contextWindowTokens;
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

export function formatRateLimitWaitMs(ms: number | null): string {
  if (!ms) return "about a minute";
  const secs = Math.ceil(ms / 1000);
  if (secs < 60) return `~${secs} seconds`;
  return `~${Math.ceil(secs / 60)} minute${Math.ceil(secs / 60) > 1 ? "s" : ""}`;
}

export function formatRateLimitWait(err: unknown): string {
  return formatRateLimitWaitMs(extractRetryAfterMs(err));
}
