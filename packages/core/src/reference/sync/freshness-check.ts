import { CRITICAL_MS, FRESH_MS, FUTURE_TOLERANCE_MS, STALE_MS } from "../freshness.js";

export type Freshness = "fresh" | "flag" | "stale" | "critical";

/**
 * Map a cache file's `metadata.last_updated` to one of four freshness bands:
 * fresh (<24h), flag (24-48h), stale (48h-7d, triggers lazy refresh),
 * critical (>7d, force sync before answering). Pure function over a clock
 * so tests can pin "now."
 */
export function freshnessOf(
  metadata: { last_updated: string },
  now: Date = new Date(),
): Freshness {
  const elapsed = now.getTime() - new Date(metadata.last_updated).getTime();
  // A `last_updated` in the future beyond a small skew tolerance is impossible;
  // a backward/frozen clock would otherwise leave `elapsed` negative forever and
  // mask arbitrarily old data as fresh. Treat it as stale so the freshness
  // annotator raises a warning instead of silently trusting it.
  if (elapsed < -FUTURE_TOLERANCE_MS) return "stale";
  if (elapsed >= CRITICAL_MS) return "critical";
  if (elapsed >= STALE_MS) return "stale";
  if (elapsed >= FRESH_MS) return "flag";
  return "fresh";
}
