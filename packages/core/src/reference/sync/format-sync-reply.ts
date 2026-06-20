import type { SyncResult } from "./run-sync.js";

/**
 * Render a `SyncResult` as athlete-facing prose for the `/sync` Telegram
 * reply. Spec shape:
 *
 * ```
 * Sync ✅
 * Last sync: 2026-05-09 14:23 UTC (32s ago)
 * Refreshed: latest, history, intervals, routes, ftp_history
 * ```
 *
 * Plus cooldown / mutex_held / unreachable variants. Pure function over a
 * clock so tests can pin "now."
 */
export function formatSyncReply(result: SyncResult, now: Date = new Date()): string {
  switch (result.kind) {
    case "skipped":
      switch (result.reason) {
        case "cooldown":
          return `Just synced — please wait ${Math.ceil((result.retryAfterMs ?? 0) / 1000)}s before forcing another refresh.`;
        case "mutex_held":
          return "A sync is already running — it'll finish within about 2 minutes; your data will be fresh then.";
        default: {
          const _exhaustive: never = result;
          throw new Error(`formatSyncReply: unhandled skipped reason ${String(_exhaustive)}`);
        }
      }
    case "failed":
      // `outer_timeout`, `gate_rejected`, and `fetch_failed` all surface to
      // athletes as the same "can't reach" message today. The future curator
      // will inspect `error_state.json` and may inject more specific guidance.
      switch (result.reason) {
        case "outer_timeout":
        case "gate_rejected":
        case "fetch_failed":
          return "I can't reach intervals.icu right now.";
        default: {
          const _exhaustive: never = result;
          throw new Error(`formatSyncReply: unhandled failed reason ${String(_exhaustive)}`);
        }
      }
    case "ran": {
      const lastLine = `Last sync: ${formatTimestamp(result.lastSyncAt, now)}`;
      // The content-hash short-circuit returns `refreshed: []` on a genuine
      // no-op cycle; rendering a bare "Refreshed: " label would be a dangling
      // line, so say nothing-changed instead.
      const detailLine =
        result.refreshed.length === 0
          ? "Already up to date — nothing changed since the last sync."
          : `Refreshed: ${result.refreshed.join(", ")}`;
      return `Sync ✅\n${lastLine}\n${detailLine}`;
    }
    default: {
      const _exhaustive: never = result;
      throw new Error(`formatSyncReply: unhandled SyncResult kind ${String(_exhaustive)}`);
    }
  }
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
