import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

import type { ErrorCaller } from "../schemas/error-state.js";

export const SYNC_HISTORY_FILE = "sync-history.jsonl";

/**
 * Size-only cap. Outcome lines are ~80–120 bytes each, so 1 MB holds tens of
 * thousands of ticks — far more than a month of frequent syncs. The history
 * file deliberately has NO age cap (unlike the rolling logger's 14-day prune):
 * answering "how often did sync fail last month, and why?" needs ~30-day
 * retention, which a coupled age cap cannot guarantee. A separate file with a
 * size-only cap is the only shape that holds the full month.
 */
export const SYNC_HISTORY_MAX_BYTES = 1 * 1024 * 1024;

export interface SyncOutcomeLine {
  readonly ts: string;
  readonly caller: ErrorCaller;
  readonly kind: "ran" | "skipped" | "failed";
  readonly reason?: string;
  readonly duration_ms: number;
}

let escalatedOnce = false;

/**
 * Reset the once-per-process escalation latch. Test-only seam: the latch is
 * module-level so a single warning fires per process in production, but unit
 * tests that assert the latch behavior need to reset it between cases.
 */
export function resetSyncHistoryEscalation(): void {
  escalatedOnce = false;
}

/**
 * Build the per-tick sync outcome writer. Each call appends exactly one JSONL
 * line to `<dataDir>/sync-history.jsonl`, rotating to `.1` on size overflow.
 *
 * The write is best-effort and NEVER throws: this is a diagnostics trail, and a
 * full disk or permission error must never break the sync tick it observes — a
 * writer that crashes the thing it records is worse than none. A once-per-
 * process `console.warn` surfaces the writer's own failure without spamming.
 */
export function createSyncHistoryWriter(
  dataDir: string,
  options: { maxBytes?: number } = {},
): (line: SyncOutcomeLine) => void {
  const maxBytes = options.maxBytes ?? SYNC_HISTORY_MAX_BYTES;
  const path = join(dataDir, SYNC_HISTORY_FILE);

  function rotateIfNeeded(): void {
    try {
      if (statSync(path).size >= maxBytes) {
        renameSync(path, `${path}.1`);
      }
    } catch {
      // File absent or unstat-able — nothing to rotate.
    }
  }

  return (line: SyncOutcomeLine): void => {
    try {
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      rotateIfNeeded();
      appendFileSync(path, JSON.stringify(line) + "\n", { encoding: "utf-8", mode: 0o600 });
    } catch {
      if (!escalatedOnce) {
        escalatedOnce = true;
        try {
          console.warn(
            "[sync-history] outcome write failed — the sync history trail is not being persisted.",
          );
        } catch {
          // Even the escalation warning is best-effort.
        }
      }
    }
  };
}
