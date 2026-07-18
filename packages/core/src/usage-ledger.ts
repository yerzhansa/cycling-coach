import { appendFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

import type { UsageLedgerLine } from "@enduragent/engine";
export type { UsageLedgerLine } from "@enduragent/engine";

export const USAGE_LEDGER_FILE = "usage-ledger.jsonl";
export const USAGE_LEDGER_MAX_BYTES = 10 * 1024 * 1024;

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
