import type { ModelMessage } from "ai";
import type { MemorySnapshot, SportMemoryShape } from "@enduragent/core";
import {
  estimateTokens,
  estimateMessagesTokens,
  messageText,
  SAFETY_MARGIN,
  MIN_PROMPT_BUDGET_TOKENS,
  SUMMARIZATION_OVERHEAD_TOKENS,
} from "./token-utils.js";
import { makeSummaryMessage } from "./history-limit.js";
import type { LLM } from "./llm.js";

// ============================================================================
// CONSTANTS
// ============================================================================

const MAX_SUMMARY_CHARS = 4_000;
const SUMMARY_TRUNCATED_MARKER = "\n\n[Summary truncated]";
const MAX_SUMMARY_TOKENS = 2048;
const BASE_CHUNK_RATIO = 0.4;
const MIN_CHUNK_RATIO = 0.15;

const REQUIRED_SUMMARY_SECTIONS = [
  "## Athlete Profile",
  "## Training Status",
  "## Discussion Context",
  "## Pending Questions",
] as const;

// ============================================================================
// PROMPT BUILDERS
// ============================================================================

function resolveTokens(
  spec: SportMemoryShape["mustPreserveTokens"],
  memory: MemorySnapshot,
): readonly string[] {
  if (typeof spec !== "function") return spec;
  try {
    return spec(memory);
  } catch (err) {
    console.warn("Sport.mustPreserveTokens function threw; using empty list", err);
    return [];
  }
}

function buildMustPreserveBlock(tokens: readonly string[]): string {
  const tokensClause = tokens.length > 0
    ? `\n\nPreserve these literal tokens exactly: ${tokens.join(", ")}.`
    : "";
  return `MUST PRESERVE:
- Athlete profile details (FTP, weight, experience, schedule, goals)
- Current training plan status and phase
- Recent workout feedback and performance trends
- Decisions made about training approach
- Any injuries, constraints, or preferences mentioned
- The last thing the athlete asked and what was being discussed

Preserve all specific numbers exactly as written (watts, kg, percentages,
dates, distances, durations).

PRIORITIZE recent context over older history.
The coach needs to know what was being discussed, not just what topics were covered.${tokensClause}`;
}

function buildSummarizePrompt(tokens: readonly string[]): string {
  return `Summarize the following conversation concisely — aim for 300-500 words total.
Use bullet points, not paragraphs. Omit generic advice that can be re-derived.

Use these exact section headings:
## Athlete Profile
## Training Status
## Discussion Context
## Pending Questions

${buildMustPreserveBlock(tokens)}`;
}

function buildDroppedMessagesPrompt(tokens: readonly string[]): string {
  return `Incorporate these older conversation messages into the existing summary.

Produce a compact, factual summary — aim for 300-500 words total.
Use bullet points, not paragraphs. Omit generic advice that can be re-derived.

Use these exact section headings:
## Athlete Profile
## Training Status
## Discussion Context
## Pending Questions

${buildMustPreserveBlock(tokens)}`;
}

// ============================================================================
// HELPERS
// ============================================================================

function formatTranscript(messages: ModelMessage[]): string {
  return messages.map((m) => `${m.role}: ${messageText(m)}`).join("\n");
}

function capSummary(summary: string): string {
  if (summary.length <= MAX_SUMMARY_CHARS) return summary;
  return summary.slice(0, MAX_SUMMARY_CHARS) + SUMMARY_TRUNCATED_MARKER;
}

export function computeAdaptiveChunkRatio(
  messages: ModelMessage[],
  contextWindowTokens: number,
): number {
  if (messages.length === 0) return BASE_CHUNK_RATIO;

  const totalTokens = estimateMessagesTokens(messages);
  const avgTokens = totalTokens / messages.length;
  const safeAvgTokens = avgTokens * SAFETY_MARGIN;
  const avgRatio = safeAvgTokens / contextWindowTokens;

  if (avgRatio > 0.1) {
    const reduction = Math.min(avgRatio * 2, BASE_CHUNK_RATIO - MIN_CHUNK_RATIO);
    return Math.max(MIN_CHUNK_RATIO, BASE_CHUNK_RATIO - reduction);
  }

  return BASE_CHUNK_RATIO;
}

export function chunkMessagesByMaxTokens(
  messages: ModelMessage[],
  maxTokens: number,
): ModelMessage[][] {
  if (messages.length === 0) return [];

  const safeMax = Math.floor(maxTokens / SAFETY_MARGIN);
  const chunks: ModelMessage[][] = [];
  let current: ModelMessage[] = [];
  let currentTokens = 0;

  for (const msg of messages) {
    const msgTokens = estimateTokens(messageText(msg));

    if (currentTokens + msgTokens > safeMax && current.length > 0) {
      chunks.push(current);
      current = [];
      currentTokens = 0;
    }

    current.push(msg);
    currentTokens += msgTokens;
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}

const DEFAULT_CONTEXT_WINDOW = 200_000;

function computeAdaptiveChunks(
  messages: ModelMessage[],
  contextWindowTokens?: number,
): ModelMessage[][] {
  if (messages.length === 0) return [];
  const ctxWindow = contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW;
  const adaptiveRatio = computeAdaptiveChunkRatio(messages, ctxWindow);
  const maxChunkTokens = Math.max(
    MIN_PROMPT_BUDGET_TOKENS,
    Math.floor(ctxWindow * adaptiveRatio) - SUMMARIZATION_OVERHEAD_TOKENS,
  );
  return chunkMessagesByMaxTokens(messages, maxChunkTokens);
}

// ============================================================================
// QUALITY AUDIT
// ============================================================================

export function auditSummaryQuality(summary: string): { ok: boolean; missing: string[] } {
  const lower = summary.toLowerCase();
  const missing = REQUIRED_SUMMARY_SECTIONS.filter(
    (section) => !lower.includes(section.toLowerCase()),
  );
  return missing.length === 0 ? { ok: true, missing: [] } : { ok: false, missing };
}

// ============================================================================
// DROPPED MESSAGE SUMMARIZATION
// ============================================================================

export async function summarizeDroppedMessages(params: {
  dropped: ModelMessage[];
  llm: LLM;
  mustPreserveTokens: SportMemoryShape["mustPreserveTokens"];
  memory: MemorySnapshot;
  previousSummary?: string;
  maxRetries?: number;
  contextWindowTokens?: number;
}): Promise<string> {
  const { dropped, llm, mustPreserveTokens, memory, previousSummary, maxRetries = 1, contextWindowTokens } = params;

  if (dropped.length === 0) return previousSummary ?? "";

  const tokens = resolveTokens(mustPreserveTokens, memory);
  const droppedPrompt = buildDroppedMessagesPrompt(tokens);
  const mustPreserveBlock = buildMustPreserveBlock(tokens);

  const chunks = computeAdaptiveChunks(dropped, contextWindowTokens);
  // Fallback: if adaptive chunking returns empty (shouldn't happen), use single chunk
  if (chunks.length === 0) chunks.push(dropped);

  let summary: string | undefined;

  for (const chunk of chunks) {
    const transcript = formatTranscript(chunk);
    const carriedSummary = summary ?? previousSummary;
    const prompt = [
      droppedPrompt,
      carriedSummary ? `\nExisting summary of earlier context:\n${carriedSummary}` : "",
      `\nMessages to incorporate:\n${transcript}`,
    ].join("\n");

    try {
      const { text } = await llm.generate({
        prompt,
        maxOutputTokens: MAX_SUMMARY_TOKENS,
      });
      summary = text;
    } catch (err) {
      console.warn("Dropped message summarization LLM call failed, using fallback", err);
    }
  }

  if (summary === undefined) return capSummary(previousSummary ?? "");

  // Quality guard with retry
  const audit = auditSummaryQuality(summary);
  if (audit.ok) return capSummary(summary);

  let best: string = summary;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const { text } = await llm.generate({
        prompt: `Restructure the following summary to include ALL required section headings: ${audit.missing.join(", ")}.\n\n${best}\n\n${mustPreserveBlock}`,
        maxOutputTokens: MAX_SUMMARY_TOKENS,
      });
      const retryAudit = auditSummaryQuality(text);
      if (retryAudit.ok) return capSummary(text);
      best = text;
    } catch (err) {
      console.warn("Dropped message summarization retry failed", err);
    }
  }

  return capSummary(best);
}

// ============================================================================
// SUMMARIZE IN STAGES
// ============================================================================

export async function summarizeInStages(params: {
  messages: ModelMessage[];
  llm: LLM;
  mustPreserveTokens: SportMemoryShape["mustPreserveTokens"];
  memory: MemorySnapshot;
  recentToKeep?: number;
  previousSummary?: string;
  contextWindowTokens?: number;
}): Promise<ModelMessage[]> {
  const { messages, llm, mustPreserveTokens, memory, recentToKeep = 4, previousSummary, contextWindowTokens } = params;

  const keepCount = Math.min(recentToKeep, messages.length);
  const toSummarize = messages.slice(0, messages.length - keepCount);
  const recent = messages.slice(messages.length - keepCount);

  if (toSummarize.length === 0) {
    return messages;
  }

  const tokens = resolveTokens(mustPreserveTokens, memory);
  const summarizePrompt = buildSummarizePrompt(tokens);

  const chunks = computeAdaptiveChunks(toSummarize, contextWindowTokens);

  // Thread previousSummary through chunk loop
  let summary = previousSummary;
  for (const chunk of chunks) {
    const transcript = formatTranscript(chunk);

    const contextPrefix = summary
      ? `\nExisting summary of earlier context:\n${summary}\n\n`
      : "";

    const { text } = await llm.generate({
      prompt: `${summarizePrompt}${contextPrefix}\n\n${transcript}`,
      maxOutputTokens: MAX_SUMMARY_TOKENS,
    });
    summary = capSummary(text);
  }

  return [makeSummaryMessage(summary!), ...recent];
}
