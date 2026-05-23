import type { Activity } from "intervals-icu-api";
import type { IntervalsActivityType } from "../sport.js";

/**
 * Reference's per-sport seam — declarative metadata + optional algorithm hooks
 * the dispatcher fans activities out to. Contract type lives next to `Sport`
 * in core because the Reference layer owns it (ADR-0010).
 *
 * Invariants — enforced by Reference's startup dispatcher, NOT by `Sport`:
 *   - Disjoint coverage: no two adapters in a sport's array claim the same
 *     `IntervalsActivityType`.
 *   - Subset coverage: the union of adapter `activityTypes` is a subset of
 *     `sport.intervalsActivityTypes`.
 *
 * Composing sports (duathlon) spread upstream sports' adapters; the
 * dispatcher's invariants catch collisions and misconfigurations at boot.
 */
export interface ReferenceSportAdapter {
  readonly activityTypes: readonly IntervalsActivityType[];
  readonly zoneBasis: "power" | "pace" | "hr";

  /**
   * Often the same as `zoneBasis`, but separated because some sports prefer
   * one signal for zones and another for decoupling (e.g., heart-rate-zone
   * running with pace-based decoupling).
   */
  readonly decouplingBasis: "power" | "pace";

  /**
   * Durations in seconds. Empty array means "do not report anchors" — chosen
   * over `null` so callers can iterate without a guard.
   */
  readonly sustainabilityAnchors: readonly number[];

  /**
   * The Reference layer's upstream protocol flags DFA as cycling-validated
   * only; running adapters set this `false` until upstream validation lands.
   */
  readonly dfaValidated: boolean;

  /**
   * Optional. When absent OR when `dfaValidated === false`, Reference's
   * curator records `{ sufficient: false }` and skips the metric.
   */
  computeDfa?(activity: Activity): DfaSummary | null;

  /** Optional. Sports without a power-equivalent curve omit this hook. */
  computePowerCurve?(activities: readonly Activity[]): PowerCurveDelta | null;
}

export interface DfaSummary {
  /**
   * `true` when the HRV stream had enough signal-to-noise for a reliable α1;
   * `false` means Reference reports "insufficient data" rather than a
   * misleading numeric.
   */
  readonly sufficient: boolean;
  /** α1 value (typically 0.5–1.5). Absent when `sufficient === false`. */
  readonly value?: number;
}

export interface PowerCurveDelta {
  readonly anchorsCovered: number;
  readonly trend?: "up" | "down" | "flat";
}
