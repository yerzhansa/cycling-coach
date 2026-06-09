// Bridge between a fetched intervals.icu bundle and the metric-compute input
// shape. The fetch layer hands this module already-renamed, already-parsed
// rows (the ADR-0012 anti-corruption rename runs upstream of here, in
// `fetch-live-bundle.ts`); this module only assembles them into the
// `FixtureShape` the registry computes consume and wraps it as a `MetricInput`.
//
// Kept pure and free of any I/O so the assembly is unit-testable without a
// network and so the parity gate's `FixtureShape` is the single shape the
// production sync and the snapshot harness both target.

import {
  FixtureSchema,
  type Activity,
  type ActivityStreams,
  type AthleteSettings,
  type FixtureShape,
  type FtpHistoryPoint,
  type HrCurveData,
  type PowerCurveData,
  type SustainabilityFamilyCurves,
  type WellnessDay,
} from "../schemas/inputs.js";
import type { MetricInput } from "../metrics/metric-input.js";

/**
 * The fetched, renamed inputs the bridge assembles into a `FixtureShape`.
 *
 * `activities` / `wellness` MUST already have passed through the rename layer
 * (`renameTpFieldsOnActivity` / `renameTpFieldsOnWellnessRow`) — this module
 * does not re-run it. The curve + stream fields are optional: when absent, the
 * corresponding capability metrics reproduce their null blocks exactly as the
 * snapshot harness does for fixtures that omit those keys.
 */
export interface ReferenceBundle {
  readonly activities: readonly Activity[];
  readonly wellness: readonly WellnessDay[];
  readonly ftpHistory: readonly FtpHistoryPoint[];
  readonly streams?: Readonly<Record<string, ActivityStreams>>;
  readonly powerCurves?: PowerCurveData;
  readonly hrCurves?: HrCurveData;
  readonly sustainabilityCurves?: Readonly<Record<string, SustainabilityFamilyCurves>>;
  readonly athlete?: AthleteSettings;
  readonly currentFtpIndoor?: number | null;
  readonly currentFtpOutdoor?: number | null;
  readonly ftpHistoryIndoor?: Readonly<Record<string, number>>;
  readonly ftpHistoryOutdoor?: Readonly<Record<string, number>>;
  readonly eftp?: number | null;
}

/**
 * Assemble + validate a `FixtureShape` from a fetched bundle. Optional keys are
 * attached only when present so the strict envelope reproduces the
 * absent-key-means-null-block behaviour the snapshot fixtures rely on (an
 * explicit `key: undefined` would still parse, but omitting keeps the cached
 * shape identical to a fixture that never carried the key).
 */
export function buildFixtureShape(bundle: ReferenceBundle): FixtureShape {
  const raw: Record<string, unknown> = {
    activities: [...bundle.activities],
    wellness: [...bundle.wellness],
    ftp_history: [...bundle.ftpHistory],
  };
  if (bundle.streams !== undefined) raw.streams = bundle.streams;
  if (bundle.powerCurves !== undefined) raw.power_curves = bundle.powerCurves;
  if (bundle.hrCurves !== undefined) raw.hr_curves = bundle.hrCurves;
  if (bundle.sustainabilityCurves !== undefined) {
    raw.sustainability_curves = bundle.sustainabilityCurves;
  }
  if (bundle.athlete !== undefined) raw.athlete = bundle.athlete;
  if (bundle.currentFtpIndoor !== undefined) raw.current_ftp_indoor = bundle.currentFtpIndoor;
  if (bundle.currentFtpOutdoor !== undefined) raw.current_ftp_outdoor = bundle.currentFtpOutdoor;
  if (bundle.ftpHistoryIndoor !== undefined) raw.ftp_history_indoor = bundle.ftpHistoryIndoor;
  if (bundle.ftpHistoryOutdoor !== undefined) raw.ftp_history_outdoor = bundle.ftpHistoryOutdoor;
  if (bundle.eftp !== undefined) raw.eftp = bundle.eftp;
  return FixtureSchema.parse(raw);
}

/** Wrap a fetched bundle as a `MetricInput` for the registry computes. */
export function buildMetricInput(bundle: ReferenceBundle, frozenNow: string): MetricInput {
  return { fixture: buildFixtureShape(bundle), frozenNow };
}
