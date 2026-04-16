import { generateText } from "ai";
import type { LanguageModel, ModelMessage } from "ai";
import { estimateTokens, estimateMessagesTokens } from "./token-utils.js";

// ============================================================================
// CONSTANTS
// ============================================================================

export const COMPACTION_CHUNKS = 2;

// ============================================================================
// PROMPTS
// ============================================================================

const MUST_PRESERVE = `MUST PRESERVE:
- Athlete profile details (FTP, weight, experience, schedule, goals)
- Current training plan status and phase
- Recent workout feedback and performance trends
- Decisions made about training approach
- Any injuries, constraints, or preferences mentioned
- The last thing the athlete asked and what was being discussed

Preserve all specific numbers exactly as written (watts, kg, percentages,
dates, distances, durations).

PRIORITIZE recent context over older history.
The coach needs to know what was being discussed, not just what topics were covered.`;

const SUMMARIZE_PROMPT = `Summarize the following conversation concisely.

${MUST_PRESERVE}`;

const MERGE_PROMPT = `Merge these partial summaries into a single cohesive summary.

${MUST_PRESERVE}`;

// ============================================================================
// CHUNK SPLITTING
// ============================================================================

export function splitMessagesByTokenShare(
  messages: ModelMessage[],
  parts: number,
): ModelMessage[][] {
  if (messages.length === 0) return [];
  if (parts <= 1) return [messages];

  const totalTokens = estimateMessagesTokens(messages);
  const targetPerChunk = totalTokens / parts;

  const chunks: ModelMessage[][] = [];
  let current: ModelMessage[] = [];
  let currentTokens = 0;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const msgTokens = estimateTokens(typeof msg.content === "string" ? msg.content : "");

    current.push(msg);
    currentTokens += msgTokens;

    // Check if we should split — but never split in the middle of a user/assistant pair
    const isAtTurnBoundary =
      msg.role === "assistant" || i === messages.length - 1;
    const hasEnoughTokens = currentTokens >= targetPerChunk;
    const hasMoreChunksNeeded = chunks.length < parts - 1;

    if (isAtTurnBoundary && hasEnoughTokens && hasMoreChunksNeeded) {
      chunks.push(current);
      current = [];
      currentTokens = 0;
    }
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}

// ============================================================================
// SUMMARIZE IN STAGES
// ============================================================================

export async function summarizeInStages(params: {
  messages: ModelMessage[];
  model: LanguageModel;
  recentToKeep?: number;
}): Promise<ModelMessage[]> {
  const { messages, model, recentToKeep = 4 } = params;

  // Determine how many recent messages to preserve (keep recent turns intact)
  const keepCount = Math.min(recentToKeep, messages.length);
  const toSummarize = messages.slice(0, messages.length - keepCount);
  const recent = messages.slice(messages.length - keepCount);

  if (toSummarize.length === 0) {
    return messages;
  }

  // Split into chunks
  const chunks = splitMessagesByTokenShare(toSummarize, COMPACTION_CHUNKS);

  // Summarize each chunk
  const summaries: string[] = [];
  for (const chunk of chunks) {
    const transcript = chunk
      .map((m) => `${m.role}: ${typeof m.content === "string" ? m.content : ""}`)
      .join("\n");

    const { text } = await generateText({
      model,
      prompt: `${SUMMARIZE_PROMPT}\n\n${transcript}`,
    });
    summaries.push(text);
  }

  // Merge if multiple summaries
  let finalSummary: string;
  if (summaries.length === 1) {
    finalSummary = summaries[0];
  } else {
    const numbered = summaries
      .map((s, i) => `Summary ${i + 1}:\n${s}`)
      .join("\n\n");

    const { text } = await generateText({
      model,
      prompt: `${MERGE_PROMPT}\n\n${numbered}`,
    });
    finalSummary = text;
  }

  // Return summary as system message + recent messages
  return [
    { role: "system" as const, content: `[Previous conversation summary]\n${finalSummary}` },
    ...recent,
  ];
}
