import type { FinishReason, LanguageModelUsage, ModelMessage } from "ai";
import { messageText } from "../sport/model-message.js";

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

export function estimateTokens(text: string): number {
  return Math.ceil((text.length / CHARS_PER_TOKEN) * SAFETY_MARGIN);
}

export function estimateMessagesTokens(messages: ModelMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateTokens(messageText(message)), 0);
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
