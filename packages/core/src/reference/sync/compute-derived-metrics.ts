// Runs the metric registry over a `MetricInput` to produce the flat
// `derived_metrics` object the sync persists into `latest.json`. Keys mirror
// the registry's own keys exactly (including dotted `capability.*` keys), so a
// downstream reader sees the same metric names the parity gate asserts.
//
// Per-metric isolation: a single compute that throws on real (sparser than
// fixture) data must not sink the whole sync — it is recorded as `null` and a
// warning is logged, leaving every other metric intact. The parity gate proves
// the computes are bit-identical on valid fixtures; this guard only covers the
// production tail where live data is shaped more loosely than a golden fixture.

import { METRIC_REGISTRY, type MetricRegistryEntry } from "../metrics/registry.js";
import type { MetricInput } from "../metrics/metric-input.js";

/** Shared between the runner + its test so the warn string stays in sync. */
export const METRIC_COMPUTE_FAILED_LOG_PREFIX = "Reference: metric compute failed";

/**
 * Registry keys omitted from a pure-pace sync when `omitPowerFamily` is set —
 * the watts-fence. Matched by EXACT STRING, never by prefix: the set mixes bare
 * keys (`eftp`) with dotted ones (`capability.power_curve_delta`), and prefix
 * matching would wrongly catch `capability.sustainability_profile` /
 * `capability.efficiency_factor`, which MUST ride through (they are
 * multi-family / tag-fenced, not omitted).
 *
 * `vo2max` is an intentional conservative over-omission — it reads a
 * sport-ambiguous wellness scalar, not a watt — so a cycling-derived value is
 * not leaked into a runner's map; a future running VO2max path will need it
 * removed from this set.
 *
 * Hand-maintained: a future power-derived registry metric must be added here or
 * it leaks a watt into a pure-pace map. There is no key-shape shortcut.
 */
export const POWER_FAMILY_OMIT_KEYS: ReadonlySet<string> = new Set([
  "eftp",
  "w_prime",
  "w_prime_kj",
  "p_max",
  "power_model_source",
  "vo2max",
  "capability.power_curve_delta",
  "capability.hr_curve_delta",
  "capability.dfa_a1_profile",
]);

export interface ComputeDerivedMetricsOptions {
  /** Sink for per-metric failures; defaults to console.warn. */
  readonly log?: (msg: string) => void;
  /** Registry override — defaults to the canonical `METRIC_REGISTRY`. Exposed
   *  for tests of the per-metric isolation path. */
  readonly registry?: Record<string, MetricRegistryEntry>;
  /** When `true`, skip the {@link POWER_FAMILY_OMIT_KEYS} — the pure-pace
   *  watts-fence. Defaults to `false`, leaving output byte-identical. */
  readonly omitPowerFamily?: boolean;
}

export function computeDerivedMetrics(
  input: MetricInput,
  opts: ComputeDerivedMetricsOptions = {},
): Record<string, unknown> {
  const log = opts.log ?? ((m: string) => console.warn(m));
  const registry = opts.registry ?? METRIC_REGISTRY;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(registry)) {
    if (opts.omitPowerFamily === true && POWER_FAMILY_OMIT_KEYS.has(key)) continue;
    try {
      out[key] = entry.compute(input);
    } catch (err) {
      log(`${METRIC_COMPUTE_FAILED_LOG_PREFIX} '${key}': ${err instanceof Error ? err.message : String(err)}`);
      out[key] = null;
    }
  }
  return out;
}
