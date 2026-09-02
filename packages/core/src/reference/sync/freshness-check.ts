import {
  referenceFreshnessAt,
  type ReferenceFreshness,
} from "@enduragent/kernel/reference/freshness";

export type Freshness = ReferenceFreshness;

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
  return referenceFreshnessAt(metadata.last_updated, now);
}
