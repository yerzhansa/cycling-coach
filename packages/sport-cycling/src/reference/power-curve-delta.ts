import type { MetricInput, PowerCurveDeltaSummary } from "@enduragent/core";
import { computePowerCurveDelta } from "@enduragent/core";

// A mean shift within ±1.0% reads as no meaningful trend. The band keeps tiny
// noise from presenting as a directional change to the athlete.
const TREND_FLAT_EPSILON_PCT = 1.0;

/**
 * Project the parity-green power-curve delta down to the thin athlete-facing
 * summary. Delegates entirely to the registry compute — no re-derivation.
 */
export function projectPowerCurveDelta(input: MetricInput): PowerCurveDeltaSummary | null {
  const delta = computePowerCurveDelta(input);
  if (delta.anchors === null) return { anchorsCovered: 0 };

  const covered = Object.values(delta.anchors).filter((a) => a.pct_change !== null);
  const anchorsCovered = covered.length;
  if (anchorsCovered < 3) return { anchorsCovered };

  const mean =
    covered.reduce((sum, a) => sum + (a.pct_change as number), 0) / anchorsCovered;
  const trend: PowerCurveDeltaSummary["trend"] =
    mean > TREND_FLAT_EPSILON_PCT ? "up" : mean < -TREND_FLAT_EPSILON_PCT ? "down" : "flat";
  return { anchorsCovered, trend };
}
