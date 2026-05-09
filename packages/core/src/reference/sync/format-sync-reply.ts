// Adapted from CrankAddict/section-11 (MIT, 2026); see NOTICE.md.

import type { SyncResult } from "./run-sync.js";

/**
 * Render a `SyncResult` as athlete-facing prose for the `/sync` Telegram
 * reply. Spec shape per F4 (US-18):
 *
 * ```
 * Sync ✅
 * Last sync: 2026-05-09 14:23 UTC (32s ago)
 * Refreshed: latest, history, intervals
 * Failures: routes (intervals.icu 503; will retry next tick)
 * ```
 *
 * Plus cooldown / mutex_held / unreachable variants. Pure function over a
 * clock so tests can pin "now."
 */
export function formatSyncReply(result: SyncResult, now: Date = new Date()): string {
  if (result.skipped === "cooldown") {
    const retrySec = Math.ceil((result.retryAfterMs ?? 0) / 1000);
    return `Just synced — please wait ${retrySec}s before forcing another refresh.`;
  }

  if (result.skipped === "mutex_held") {
    return "Another sync in progress — please retry in a moment.";
  }

  if (!result.ok) {
    const last = result.lastSyncAt
      ? `\nLast good sync: ${formatTimestamp(result.lastSyncAt, now)}`
      : "";
    return `I can't reach intervals.icu right now.${last}`;
  }

  const lastLine = result.lastSyncAt
    ? `Last sync: ${formatTimestamp(result.lastSyncAt, now)}`
    : "Last sync: just now";
  const refreshedLine = `Refreshed: ${result.refreshed.join(", ")}`;
  const failuresLine =
    result.failures.length > 0
      ? `\nFailures: ${result.failures
          .map((f) => `${f.file} (${f.reason})`)
          .join(", ")}`
      : "";
  return `Sync ✅\n${lastLine}\n${refreshedLine}${failuresLine}`;
}

function formatTimestamp(iso: string, now: Date): string {
  const d = new Date(iso);
  const diffMs = Math.max(0, now.getTime() - d.getTime());
  const diffSec = Math.round(diffMs / 1000);
  const ago =
    diffSec < 60
      ? `${diffSec}s ago`
      : diffSec < 3600
        ? `${Math.round(diffSec / 60)} min ago`
        : `${Math.round(diffSec / 3600)} h ago`;
  const utc = `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  return `${utc} (${ago})`;
}
