import { appendFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

export const USAGE_LEDGER_FILE = "usage-ledger.jsonl";
export const USAGE_LEDGER_MAX_BYTES = 10 * 1024 * 1024;

export interface UsageLedgerLine {
  ts: number;
  kind: "generate" | "turn" | "boot";
  provider: string;
  model: string;
  durationMs: number;
  // Populated on per-generation lines; absent on the whole-turn and boot lines.
  caller?: "chat" | "flush" | "compact";
  steps?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  stopReason?: string;
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
