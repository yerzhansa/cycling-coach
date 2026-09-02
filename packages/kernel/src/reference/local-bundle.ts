import type { ReferenceCaptureClock, ReferenceCaptureManifest, SnapshotRef } from "./capture.js";
import type { MetricInput } from "./metrics/metric-input.js";
import { SPORT_FAMILIES } from "./metrics/sport-families.js";
import {
  FixtureSchema,
  type Activity,
  type ActivityStreams,
  type AthleteSettings,
  type FixtureShape,
  type FtpHistoryPoint,
  type HrCurveData,
  type PlannedEvent,
  type PowerCurveData,
  type SustainabilityFamilyCurves,
  type WellnessDay,
} from "./schemas/inputs.js";

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
  readonly pastEvents?: readonly PlannedEvent[];
}

export type ReferenceBundleProjection = (bundle: ReferenceBundle) => ReferenceBundle;

export const IDENTITY_REFERENCE_BUNDLE_PROJECTION: ReferenceBundleProjection = (bundle) => bundle;

function isProjectedCyclingActivity(activity: ReferenceBundle["activities"][number]): boolean {
  const type = activity.type;
  return (
    typeof type === "string" &&
    type !== "Transition" &&
    Object.hasOwn(SPORT_FAMILIES, type) &&
    SPORT_FAMILIES[type] === "cycling"
  );
}

export function projectCyclingReferenceBundle(bundle: ReferenceBundle): ReferenceBundle {
  const activities = bundle.activities.filter(isProjectedCyclingActivity);
  const retainedActivityIds = new Set(activities.map((activity) => String(activity.id)));
  let streams: Record<string, ActivityStreams> | undefined;
  if (bundle.streams !== undefined) {
    streams = {};
    for (const [activityId, value] of Object.entries(bundle.streams)) {
      if (retainedActivityIds.has(activityId)) streams[activityId] = value;
    }
  }
  const hasNoOrphanStreams = Object.keys(streams ?? {}).every((activityId) =>
    retainedActivityIds.has(activityId),
  );
  if (!hasNoOrphanStreams)
    throw new Error("cycling Reference projection produced an orphan stream");
  return streams === undefined ? { ...bundle, activities } : { ...bundle, activities, streams };
}

export interface ProducedLocalBundle {
  readonly captureId: string;
  readonly captureClock: ReferenceCaptureClock;
  readonly bundle: ReferenceBundle;
}

export interface LocalBundleProducer {
  produce(manifest: ReferenceCaptureManifest): Promise<ProducedLocalBundle>;
}

export interface VerifiedSnapshotReader {
  readVerifiedSnapshot(ref: SnapshotRef): Promise<unknown>;
}

export function buildFixtureShape(bundle: ReferenceBundle): FixtureShape {
  const raw: Record<string, unknown> = {
    activities: [...bundle.activities],
    wellness: [...bundle.wellness],
    ftp_history: [...bundle.ftpHistory],
  };
  if (bundle.streams !== undefined) raw.streams = bundle.streams;
  if (bundle.powerCurves !== undefined) raw.power_curves = bundle.powerCurves;
  if (bundle.hrCurves !== undefined) raw.hr_curves = bundle.hrCurves;
  if (bundle.sustainabilityCurves !== undefined)
    raw.sustainability_curves = bundle.sustainabilityCurves;
  if (bundle.athlete !== undefined) raw.athlete = bundle.athlete;
  if (bundle.currentFtpIndoor !== undefined) raw.current_ftp_indoor = bundle.currentFtpIndoor;
  if (bundle.currentFtpOutdoor !== undefined) raw.current_ftp_outdoor = bundle.currentFtpOutdoor;
  if (bundle.ftpHistoryIndoor !== undefined) raw.ftp_history_indoor = bundle.ftpHistoryIndoor;
  if (bundle.ftpHistoryOutdoor !== undefined) raw.ftp_history_outdoor = bundle.ftpHistoryOutdoor;
  if (bundle.eftp !== undefined) raw.eftp = bundle.eftp;
  if (bundle.pastEvents !== undefined) raw.past_events = [...bundle.pastEvents];
  return FixtureSchema.parse(raw);
}

export function buildMetricInput(bundle: ReferenceBundle, frozenNow: string): MetricInput {
  return { fixture: buildFixtureShape(bundle), frozenNow };
}

export type ActivityProjectionFilter = (activity: Activity) => boolean;

export const KEEP_ALL_ACTIVITIES: ActivityProjectionFilter = () => true;

export function applyActivityProjectionFilter(
  bundle: ReferenceBundle,
  keep: ActivityProjectionFilter,
): ReferenceBundle {
  const retained = bundle.activities.filter((activity) => keep(activity));
  if (bundle.streams === undefined) return { ...bundle, activities: retained };
  const activityIds = new Set(bundle.activities.map((activity) => String(activity.id)));
  for (const id of Object.keys(bundle.streams)) {
    if (!activityIds.has(id)) throw new TypeError("local bundle contains an orphan stream");
  }
  const retainedIds = new Set(retained.map((activity) => String(activity.id)));
  const streams: Record<string, ActivityStreams> = {};
  for (const [id, value] of Object.entries(bundle.streams))
    if (retainedIds.has(id)) streams[id] = value;
  return { ...bundle, activities: retained, streams };
}
