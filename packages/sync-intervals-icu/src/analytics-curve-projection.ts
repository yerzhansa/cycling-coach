import {
  AthleteHeartRateCurveSetSchema,
  AthletePowerCurveSetSchema,
  decode,
} from "intervals-icu-api";
import type {
  ReferenceBundle,
  VerifiedSnapshotReader,
} from "@enduragent/kernel/reference/local-bundle";
import { ANALYTICS_CURVE_PARTS, type AnalyticsCurveState } from "@enduragent/kernel/store";

const MAX_PROJECTED_AXIS_LENGTH = 65_536;
const ACTIVITY_TYPES = Object.freeze(["Ride", "VirtualRide"] as const);

type CurrentAnalyticsCurves = NonNullable<AnalyticsCurveState["current"]>;
type ActivityType = (typeof ACTIVITY_TYPES)[number];
type CurveFamily = "power" | "heart-rate";
type CurveProjection = Required<
  Pick<ReferenceBundle, "powerCurves" | "hrCurves" | "sustainabilityCurves">
>;

interface NormalizedCurve {
  readonly id: string;
  readonly secs: readonly number[];
  readonly values: readonly (number | null)[];
}

export class AnalyticsCurveProjectionError extends Error {
  readonly code = "ANALYTICS_CURVE_PROJECTION_FAILED";

  constructor() {
    super("analytics curve evidence could not be projected");
    this.name = "AnalyticsCurveProjectionError";
    this.stack = `${this.name}: ${this.message}`;
    Object.freeze(this);
  }
}

function fail(): never {
  throw new AnalyticsCurveProjectionError();
}

function partKey(family: CurveFamily, activityType: ActivityType): string {
  return `${family}:${activityType}`;
}

function normalizeCurve(
  id: string,
  secs: readonly number[],
  values: readonly (number | null)[],
): NormalizedCurve {
  if (secs.length !== values.length || secs.length > MAX_PROJECTED_AXIS_LENGTH) fail();
  const projectedSecs: number[] = [];
  const projectedValues: (number | null)[] = [];
  let previous = 0;
  for (let index = 0; index < secs.length; index += 1) {
    const seconds = secs[index];
    const value = values[index];
    if (
      !Number.isSafeInteger(seconds) ||
      seconds <= previous ||
      (value !== null && (!Number.isFinite(value) || value < 0))
    )
      fail();
    projectedSecs.push(seconds);
    projectedValues.push(value);
    previous = seconds;
  }
  return Object.freeze({
    id,
    secs: Object.freeze(projectedSecs),
    values: Object.freeze(projectedValues),
  });
}

function selectPowerCurves(
  payload: unknown,
  selectors: ReadonlySet<string>,
): readonly NormalizedCurve[] {
  const decoded = decode(AthletePowerCurveSetSchema, payload);
  if (!decoded.ok) fail();
  const seen = new Set<string>();
  const selected: NormalizedCurve[] = [];
  for (const curve of decoded.value.list) {
    if (typeof curve.id !== "string" || !selectors.has(curve.id)) continue;
    if (seen.has(curve.id)) fail();
    seen.add(curve.id);
    selected.push(normalizeCurve(curve.id, curve.secs, curve.values));
  }
  return Object.freeze(selected);
}

function selectHeartRateCurves(
  payload: unknown,
  selectors: ReadonlySet<string>,
): readonly NormalizedCurve[] {
  const decoded = decode(AthleteHeartRateCurveSetSchema, payload);
  if (!decoded.ok) fail();
  const seen = new Set<string>();
  const selected: NormalizedCurve[] = [];
  for (const curve of decoded.value.list) {
    if (typeof curve.id !== "string" || !selectors.has(curve.id)) continue;
    if (seen.has(curve.id)) fail();
    seen.add(curve.id);
    selected.push(normalizeCurve(curve.id, curve.secs, curve.values));
  }
  return Object.freeze(selected);
}

function curveById(curves: readonly NormalizedCurve[], id: string): NormalizedCurve | undefined {
  return curves.find((curve) => curve.id === id);
}

function aggregateCurves(
  curvesByType: Readonly<Record<ActivityType, readonly NormalizedCurve[]>>,
  selectors: readonly string[],
): readonly NormalizedCurve[] {
  // The headline delta is family-wide. Reconstruct the provider's cycling-family best curve
  // from the explicitly separated outdoor/indoor evidence by taking the best value per duration.
  const aggregated: NormalizedCurve[] = [];
  for (const id of selectors) {
    const bySecond = new Map<number, number | null>();
    for (const activityType of ACTIVITY_TYPES) {
      const curve = curveById(curvesByType[activityType], id);
      if (curve === undefined) continue;
      for (let index = 0; index < curve.secs.length; index += 1) {
        const seconds = curve.secs[index]!;
        const value = curve.values[index] ?? null;
        const previous = bySecond.get(seconds);
        if (previous === undefined || previous === null || (value !== null && value > previous)) {
          bySecond.set(seconds, value);
        }
      }
    }
    if (bySecond.size === 0) continue;
    const secs = [...bySecond.keys()].sort((left, right) => left - right);
    aggregated.push(
      Object.freeze({
        id,
        secs: Object.freeze(secs),
        values: Object.freeze(secs.map((seconds) => bySecond.get(seconds) ?? null)),
      }),
    );
  }
  return Object.freeze(aggregated);
}

function powerEnvelope(
  curves: readonly NormalizedCurve[],
): NonNullable<ReferenceBundle["powerCurves"]> {
  const list = curves.map((curve) => {
    const secs = [...curve.secs];
    const watts = [...curve.values];
    const entry = { id: curve.id, secs, watts };
    Object.freeze(secs);
    Object.freeze(watts);
    return Object.freeze(entry);
  });
  Object.freeze(list);
  return Object.freeze({ list });
}

function heartRateEnvelope(
  curves: readonly NormalizedCurve[],
): NonNullable<ReferenceBundle["hrCurves"]> {
  const list = curves.map((curve) => {
    const secs = [...curve.secs];
    const values = [...curve.values];
    const entry = { id: curve.id, secs, values };
    Object.freeze(secs);
    Object.freeze(values);
    return Object.freeze(entry);
  });
  Object.freeze(list);
  return Object.freeze({ list });
}

async function projectCurrentAnalyticsCurves(
  current: CurrentAnalyticsCurves,
  snapshots: VerifiedSnapshotReader,
): Promise<CurveProjection> {
  if (typeof snapshots?.readVerifiedSnapshot !== "function") fail();
  const evidenceByPart = new Map<string, CurrentAnalyticsCurves["evidence"][number]>();
  for (const evidence of current.evidence) {
    const key = partKey(evidence.curveFamily, evidence.activityType);
    if (evidenceByPart.has(key)) fail();
    evidenceByPart.set(key, evidence);
  }
  if (evidenceByPart.size !== ANALYTICS_CURVE_PARTS.length) fail();

  const windows = current.generation.windows;
  const selectors = Object.freeze([
    `r.${windows.current.start}.${windows.current.end}`,
    `r.${windows.previous.start}.${windows.previous.end}`,
    `r.${windows.sustainability.start}.${windows.sustainability.end}`,
  ]);
  const selectorSet = new Set(selectors);
  const projected = new Map<string, readonly NormalizedCurve[]>();

  for (const part of ANALYTICS_CURVE_PARTS) {
    const evidence = evidenceByPart.get(partKey(part.curveFamily, part.activityType));
    if (evidence === undefined) fail();
    const payload = await snapshots.readVerifiedSnapshot({
      address: evidence.archiveAddress,
      rel_path: evidence.archiveRelPath,
    });
    projected.set(
      partKey(part.curveFamily, part.activityType),
      part.curveFamily === "power"
        ? selectPowerCurves(payload, selectorSet)
        : selectHeartRateCurves(payload, selectorSet),
    );
  }

  const curves = (family: CurveFamily, activityType: ActivityType): readonly NormalizedCurve[] =>
    projected.get(partKey(family, activityType)) ?? fail();
  const powerByType = Object.freeze({
    Ride: curves("power", "Ride"),
    VirtualRide: curves("power", "VirtualRide"),
  });
  const heartRateByType = Object.freeze({
    Ride: curves("heart-rate", "Ride"),
    VirtualRide: curves("heart-rate", "VirtualRide"),
  });
  const sustainabilityId = selectors[2]!;

  return Object.freeze({
    powerCurves: powerEnvelope(aggregateCurves(powerByType, selectors)),
    hrCurves: heartRateEnvelope(aggregateCurves(heartRateByType, selectors)),
    sustainabilityCurves: Object.freeze({
      cycling: Object.freeze({
        power: Object.freeze({
          Ride: powerEnvelope(
            curveById(powerByType.Ride, sustainabilityId)
              ? [curveById(powerByType.Ride, sustainabilityId)!]
              : [],
          ),
          VirtualRide: powerEnvelope(
            curveById(powerByType.VirtualRide, sustainabilityId)
              ? [curveById(powerByType.VirtualRide, sustainabilityId)!]
              : [],
          ),
        }),
        hr: Object.freeze({
          Ride: heartRateEnvelope(
            curveById(heartRateByType.Ride, sustainabilityId)
              ? [curveById(heartRateByType.Ride, sustainabilityId)!]
              : [],
          ),
          VirtualRide: heartRateEnvelope(
            curveById(heartRateByType.VirtualRide, sustainabilityId)
              ? [curveById(heartRateByType.VirtualRide, sustainabilityId)!]
              : [],
          ),
        }),
      }),
    }),
  });
}

/**
 * Rebuild the existing metric-input curve envelopes exclusively from the last promoted,
 * archive-verified four-part generation. No provider client or request surface is accepted here.
 */
export async function projectAnalyticsCurveEvidence(
  current: CurrentAnalyticsCurves,
  snapshots: VerifiedSnapshotReader,
): Promise<CurveProjection> {
  try {
    return await projectCurrentAnalyticsCurves(current, snapshots);
  } catch {
    throw new AnalyticsCurveProjectionError();
  }
}
