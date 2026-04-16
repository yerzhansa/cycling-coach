import type { ModelMessage } from "ai";

export const CHARS_PER_TOKEN = 4;
export const SAFETY_MARGIN = 1.2;
export const RESERVE_TOKENS = 4096;
export const MIN_PROMPT_BUDGET_TOKENS = 8000;
export const MIN_PROMPT_BUDGET_RATIO = 0.5;
export const TIMEOUT_COMPACTION_THRESHOLD = 0.65;

export function estimateTokens(text: string): number {
  return Math.ceil((text.length / CHARS_PER_TOKEN) * SAFETY_MARGIN);
}

export function estimateMessagesTokens(messages: ModelMessage[]): number {
  return messages.reduce(
    (sum, m) => sum + estimateTokens(typeof m.content === "string" ? m.content : ""),
    0,
  );
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
