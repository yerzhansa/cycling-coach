/**
 * Step 6b (HARD): local clock vs the server response timestamp drift stays
 * under one hour. Maps to the upstream protocol's clock-offset check. See
 * `NOTICE.md` for license attribution.
 */
import type { FetchedReference } from "../../sync/run-sync.js";
import type { CheckResult } from "../sync-gate.js";

const CLOCK_DRIFT_MAX_MS = 60 * 60 * 1000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

/** Server-stamped timestamp only — drift can only be assessed against the
 *  server's own clock, never an activity's local-time stamp. */
function serverTimestamp(fetched: FetchedReference): string | null {
  const latest = asRecord(fetched?.latest);
  const metadata = latest === null ? null : asRecord(latest.metadata);
  if (metadata !== null && typeof metadata.last_updated === "string") {
    return metadata.last_updated;
  }
  return null;
}

export function checkClockOffset(fetched: FetchedReference, now: Date): CheckResult {
  const ts = serverTimestamp(fetched);
  if (ts === null) return { failures: [], warnings: [] };

  const serverMs = Date.parse(ts);
  if (!Number.isFinite(serverMs)) return { failures: [], warnings: [] };

  const driftMs = Math.abs(now.getTime() - serverMs);
  if (driftMs <= CLOCK_DRIFT_MAX_MS) return { failures: [], warnings: [] };

  return {
    failures: [
      {
        step: "step6b_clock_offset",
        detail: `clock drift ${Math.round(driftMs / 60000)}min exceeds 60min`,
      },
    ],
    warnings: [],
  };
}
