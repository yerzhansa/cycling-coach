import { appendFileSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

import type { UsageLedgerLine } from "@enduragent/engine";
export type { UsageLedgerLine } from "@enduragent/engine";

export const USAGE_LEDGER_FILE = "usage-ledger.jsonl";
export const USAGE_LEDGER_MAX_BYTES = 10 * 1024 * 1024;

export interface UsageLedgerReadResult {
  readonly lines: readonly UsageLedgerLine[];
  readonly malformedLineCount: number;
}

export function readUsageLedger(dataDir: string): UsageLedgerReadResult {
  const livePath = join(dataDir, USAGE_LEDGER_FILE);
  const lines: UsageLedgerLine[] = [];
  let malformedLineCount = 0;
  for (const path of [`${livePath}.1`, livePath]) {
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") malformedLineCount += 1;
      continue;
    }
    const records = raw.split("\n");
    if (records.at(-1) === "") records.pop();
    for (const record of records) {
      try {
        const value = JSON.parse(record) as unknown;
        if (value === null || typeof value !== "object" || Array.isArray(value)) {
          malformedLineCount += 1;
        } else {
          lines.push(value as UsageLedgerLine);
        }
      } catch {
        malformedLineCount += 1;
      }
    }
  }
  return { lines, malformedLineCount };
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
