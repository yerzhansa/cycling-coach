import type { ModelMessage } from "ai";
import { estimateTokens, estimateMessagesTokens } from "./token-utils.js";
import { messageText } from "../sport/model-message.js";
import {
  getMessageProvenance,
  setMessageProvenance,
  type SourceProvenance,
} from "../provenance.js";

export const SUMMARY_PREFIX = "[Previous conversation summary]";

export interface SplitResult {
  kept: ModelMessage[];
  dropped: ModelMessage[];
  previousSummary: string | undefined;
  previousSummaryProvenance: SourceProvenance | undefined;
}

export function splitHistoryByBudget(params: {
  messages: ModelMessage[];
  tokenBudget: number;
}): SplitResult {
  const { messages, tokenBudget } = params;

  if (messages.length === 0) {
    return {
      kept: [],
      dropped: [],
      previousSummary: undefined,
      previousSummaryProvenance: undefined,
    };
  }

  // Extract existing summary from messages[0] if present
  let previousSummary: string | undefined;
  let previousSummaryProvenance: SourceProvenance | undefined;
  let conversationMessages: ModelMessage[];

  const first = messages[0];
  if (
    first.role === "system" &&
    typeof first.content === "string" &&
    first.content.startsWith(SUMMARY_PREFIX)
  ) {
    previousSummary = first.content.slice(SUMMARY_PREFIX.length + 1); // skip prefix + newline
    previousSummaryProvenance = getMessageProvenance(first);
    conversationMessages = messages.slice(1);
  } else {
    previousSummary = undefined;
    previousSummaryProvenance = undefined;
    conversationMessages = messages;
  }

  // Drop oldest messages until within token budget (keep at least 1)
  let startIdx = 0;
  let totalTokens = estimateMessagesTokens(conversationMessages);

  while (totalTokens > tokenBudget && startIdx < conversationMessages.length - 1) {
    totalTokens -= estimateTokens(messageText(conversationMessages[startIdx]));
    startIdx++;
  }

  const dropped = conversationMessages.slice(0, startIdx);
  const kept = conversationMessages.slice(startIdx);

  return { kept, dropped, previousSummary, previousSummaryProvenance };
}

export function makeSummaryMessage(
  summaryText: string,
  provenance: SourceProvenance = { garmin: false, nonGarmin: false, unknown: true },
): ModelMessage {
  return setMessageProvenance(
    { role: "system", content: `${SUMMARY_PREFIX}\n${summaryText}` },
    provenance,
  );
}
