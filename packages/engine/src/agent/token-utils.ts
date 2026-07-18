import type { ModelMessage } from "ai";
import { messageText } from "../sport/model-message.js";

export const CHARS_PER_TOKEN = 4;
export const SAFETY_MARGIN = 1.2;
export const RESERVE_TOKENS = 20_000;
export const MIN_PROMPT_BUDGET_TOKENS = 8000;
export const TIMEOUT_COMPACTION_THRESHOLD = 0.65;
export const SUMMARIZATION_OVERHEAD_TOKENS = 4096;

export function estimateTokens(text: string): number {
  return Math.ceil((text.length / CHARS_PER_TOKEN) * SAFETY_MARGIN);
}

export function estimateMessagesTokens(messages: ModelMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateTokens(messageText(message)), 0);
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
