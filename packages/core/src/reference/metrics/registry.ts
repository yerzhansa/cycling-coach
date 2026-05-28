/**
 * Authoritative list of metrics the parity gate can assert. Each entry
 * holds the typed compute function directly — the gate calls
 * `entry.compute(input)` without dynamic imports or path resolution.
 *
 * Adding a metric: implement it in a sibling file, import its `compute*`
 * function here, and register the entry. The Vitest matrix at
 * `packages/core/tests/reference-parity.test.ts` picks it up automatically.
 */

import {
  computeBenchmarkIndoor,
  computeBenchmarkOutdoor,
  computeConsistencyDetails,
  computeConsistencyIndex,
  computeHasIntervals,
} from "./compliance-and-body.js";
import {
  computeEasyTimeRatio,
  computeEasyTimeRatioNote,
  computeGreyZoneNote,
  computeGreyZonePercentage,
  computeQualityIntensityNote,
  computeQualityIntensityPercentage,
  computeSeilerTid,
  computeSeilerTid28d,
  computeSeilerTid28dPrimary,
  computeSeilerTidPrimary,
  computeZoneDistribution7d,
} from "./distribution.js";
import {
  computeAcwr,
  computeEffectiveMonotony,
  computeLoadRecoveryRatio,
  computeMonotony,
  computeMonotonyInterpretation,
  computePrimarySportMonotony,
  computeRecoveryIndex,
  computeStrain,
  computeStressTolerance,
} from "./load-management.js";
import type { MetricInput } from "./metric-input.js";
import { computeSeasonalContext } from "./seasonal-context.js";

export interface MetricRegistryEntry {
  compute: (input: MetricInput) => unknown;
}

export const METRIC_REGISTRY: Record<string, MetricRegistryEntry> = {
  acwr: { compute: computeAcwr },
  monotony: { compute: computeMonotony },
  primary_sport_monotony: { compute: computePrimarySportMonotony },
  effective_monotony: { compute: computeEffectiveMonotony },
  monotony_interpretation: { compute: computeMonotonyInterpretation },
  strain: { compute: computeStrain },
  recovery_index: { compute: computeRecoveryIndex },
  stress_tolerance: { compute: computeStressTolerance },
  load_recovery_ratio: { compute: computeLoadRecoveryRatio },
  zone_distribution_7d: { compute: computeZoneDistribution7d },
  grey_zone_percentage: { compute: computeGreyZonePercentage },
  grey_zone_note: { compute: computeGreyZoneNote },
  quality_intensity_percentage: { compute: computeQualityIntensityPercentage },
  quality_intensity_note: { compute: computeQualityIntensityNote },
  easy_time_ratio: { compute: computeEasyTimeRatio },
  easy_time_ratio_note: { compute: computeEasyTimeRatioNote },
  seiler_tid_7d: { compute: computeSeilerTid },
  seiler_tid_7d_primary: { compute: computeSeilerTidPrimary },
  seiler_tid_28d: { compute: computeSeilerTid28d },
  seiler_tid_28d_primary: { compute: computeSeilerTid28dPrimary },
  consistency_index: { compute: computeConsistencyIndex },
  consistency_details: { compute: computeConsistencyDetails },
  seasonal_context: { compute: computeSeasonalContext },
  benchmark_indoor: { compute: computeBenchmarkIndoor },
  benchmark_outdoor: { compute: computeBenchmarkOutdoor },
  has_intervals: { compute: computeHasIntervals },
};
