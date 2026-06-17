import { appendFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

import type { GenerateResult } from "./llm-types.js";

export const USAGE_LEDGER_FILE = "usage-ledger.jsonl";
export const USAGE_LEDGER_MAX_BYTES = 10 * 1024 * 1024;

export interface UsageLedgerLine {
  ts: number;
  kind: "generate" | "turn" | "boot";
  provider: string;
  model: string;
  durationMs: number;
  // Populated on per-generation lines and on the whole-turn line; absent on the
  // boot line. On a turn line the token/cost figures are the final successful
  // generation's, not a sum across retry/compaction attempts.
  caller?: "chat" | "flush" | "compact";
  // Prompt-template lineage of the turn (computeTemplateHash). Present only on
  // kind:"turn" lines, where it makes a latency/usage sample self-attributable
  // to a prompt revision without a timestamp join against the chat-store JSONL.
  templateHash?: string;
  steps?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  stopReason?: string;
}

// The AI SDK leaves `inputTokenDetails` loosely typed; this is the single point
// where its cache-token shape is asserted, so every consumer reads it the same way.
export function cacheTokenDetails(
  usage: GenerateResult["totalUsage"],
): { cacheReadTokens?: number; cacheWriteTokens?: number } | undefined {
  return usage?.inputTokenDetails as
    | { cacheReadTokens?: number; cacheWriteTokens?: number }
    | undefined;
}

// Maps a completed generation's whole-turn usage and derived cost onto the
// ledger's token/cost fields. The per-generation line and the per-turn line
// carry the same shape, so both build it through this one mapper.
export function usageFieldsFromResult(
  result: GenerateResult,
): Pick<
  UsageLedgerLine,
  "inputTokens" | "outputTokens" | "totalTokens" | "cacheReadTokens" | "cacheWriteTokens" | "cost"
> {
  const usage = result.totalUsage;
  const details = cacheTokenDetails(usage);
  return {
    inputTokens: usage?.inputTokens,
    outputTokens: usage?.outputTokens,
    totalTokens: usage?.totalTokens,
    cacheReadTokens: details?.cacheReadTokens,
    cacheWriteTokens: details?.cacheWriteTokens,
    cost: result.cost,
  };
}

export function appendUsageLine(dataDir: string, line: UsageLedgerLine): void {
  // Best-effort observability sink: a ledger write must never break a chat
  // turn, so every filesystem call is swallowed on failure.
  try {
    const path = join(dataDir, USAGE_LEDGER_FILE);
    try {
      if (statSync(path).size >= USAGE_LEDGER_MAX_BYTES) {
        renameSync(path, `${path}.1`);
      }
    } catch {
      // File absent or unstat-able — nothing to rotate.
    }
    appendFileSync(path, JSON.stringify(line) + "\n", { encoding: "utf-8", mode: 0o600 });
  } catch {
    // Swallow: observability failure is not a turn failure.
  }
}
