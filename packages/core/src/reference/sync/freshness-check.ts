import { CRITICAL_MS, FRESH_MS, STALE_MS } from "../freshness.js";

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
  if (elapsed >= CRITICAL_MS) return "critical";
  if (elapsed >= STALE_MS) return "stale";
  if (elapsed >= FRESH_MS) return "flag";
  return "fresh";
}
