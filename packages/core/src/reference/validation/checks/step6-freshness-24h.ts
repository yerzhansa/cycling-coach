/**
 * Step 6 (SOFT): annotate data freshness against the 24/48h/7d bands. Maps to
 * the upstream protocol's freshness check. Never hard-fails — a stale-but-valid
 * bundle still commits, carrying the band forward as a warning. See `NOTICE.md`
 * for license attribution.
 */
import type { FetchedReference } from "../../sync/run-sync.js";
import type { CheckResult } from "../sync-gate.js";
import { freshnessOf, type Freshness } from "../../sync/freshness-check.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Best-effort source timestamp for the fetched bundle: the latest envelope's
 * server-stamped `metadata.last_updated` when present, else the newest activity
 * `start_date_local`. Returns `null` when neither is available (cannot assess).
 */
export function sourceTimestamp(fetched: FetchedReference): string | null {
  const latest = asRecord(fetched?.latest);
  const metadata = latest === null ? null : asRecord(latest.metadata);
  if (metadata !== null && typeof metadata.last_updated === "string") {
    return metadata.last_updated;
  }

  const activities = fetched?.latest?.recent_activities;
  if (Array.isArray(activities)) {
    let newest: string | null = null;
    let newestMs = -Infinity;
    for (const a of activities) {
      const r = asRecord(a);
      if (r === null || typeof r.start_date_local !== "string") continue;
      const ms = Date.parse(r.start_date_local);
      if (Number.isFinite(ms) && ms > newestMs) {
        newestMs = ms;
        newest = r.start_date_local;
      }
    }
    return newest;
  }

  return null;
}

export function checkFreshness(
  fetched: FetchedReference,
  now: Date,
): CheckResult & { freshness: Freshness } {
  const ts = sourceTimestamp(fetched);
  if (ts === null) {
    return { failures: [], warnings: [], freshness: "fresh" };
  }

  const freshness = freshnessOf({ last_updated: ts }, now);
  return {
    failures: [],
    warnings:
      freshness === "fresh"
        ? []
        : [{ step: "step6_freshness_24h", detail: `data freshness=${freshness}` }],
    freshness,
  };
}
