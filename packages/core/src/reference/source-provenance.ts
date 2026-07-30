import type { ReferenceBundle } from "./sync/fixture-bridge.js";
import type { LatestJson } from "./schemas/latest.js";
import {
  EMPTY_PROVENANCE,
  UNKNOWN_PROVENANCE,
  isNonEmptyData,
  provenanceForSourceBearingData,
  unionProvenance,
  type SourceProvenance,
} from "../provenance.js";

export interface LatestSourceProvenance {
  readonly athlete_profile: SourceProvenance;
  readonly current_status: SourceProvenance;
  readonly derived_metrics: SourceProvenance;
  readonly recent_activities: SourceProvenance;
  readonly planned_workouts: SourceProvenance;
  readonly wellness_data: SourceProvenance;
}

function activityProvenance(value: unknown): SourceProvenance {
  return isNonEmptyData(value) ? provenanceForSourceBearingData(value) : EMPTY_PROVENANCE;
}

function unknownIfNonEmpty(value: unknown): SourceProvenance {
  return isNonEmptyData(value) ? UNKNOWN_PROVENANCE : EMPTY_PROVENANCE;
}

export function deriveBundleProvenance(bundle: ReferenceBundle): SourceProvenance {
  let all = unionProvenance(
    activityProvenance(bundle.activities),
    unknownIfNonEmpty(bundle.wellness),
    unknownIfNonEmpty(bundle.athlete),
  );
  for (const value of [
    bundle.ftpHistory,
    bundle.streams,
    bundle.powerCurves,
    bundle.hrCurves,
    bundle.sustainabilityCurves,
    bundle.currentFtpIndoor,
    bundle.currentFtpOutdoor,
    bundle.ftpHistoryIndoor,
    bundle.ftpHistoryOutdoor,
    bundle.eftp,
  ]) {
    if (isNonEmptyData(value)) all = unionProvenance(all, UNKNOWN_PROVENANCE);
  }
  return all;
}

export function buildLatestSourceProvenance(params: {
  bundle: ReferenceBundle;
  athleteProfile: unknown;
  recentActivities: readonly unknown[];
  wellnessData: unknown;
}): LatestSourceProvenance {
  return {
    athlete_profile: unknownIfNonEmpty(params.athleteProfile),
    current_status: EMPTY_PROVENANCE,
    derived_metrics: deriveBundleProvenance(params.bundle),
    recent_activities: activityProvenance(params.recentActivities),
    planned_workouts: EMPTY_PROVENANCE,
    wellness_data: unknownIfNonEmpty(params.wellnessData),
  };
}

export function provenanceForLatestSection(
  latest: LatestJson,
  section: keyof LatestSourceProvenance,
): SourceProvenance {
  if (section === "recent_activities") return activityProvenance(latest.recent_activities);
  const persisted = latest.source_provenance?.[section];
  if (persisted !== undefined) return persisted;
  if (section === "athlete_profile") return unknownIfNonEmpty(latest.athlete_profile);
  if (section === "wellness_data") return unknownIfNonEmpty(latest.wellness_data);
  if (section === "planned_workouts") return unknownIfNonEmpty(latest.planned_workouts);
  if (section === "current_status") return unknownIfNonEmpty(latest.current_status);
  return isNonEmptyData(latest.derived_metrics) ? UNKNOWN_PROVENANCE : EMPTY_PROVENANCE;
}

export function provenanceForLatest(latest: LatestJson): SourceProvenance {
  return (
    Object.keys({
      athlete_profile: true,
      current_status: true,
      derived_metrics: true,
      recent_activities: true,
      planned_workouts: true,
      wellness_data: true,
    }) as Array<keyof LatestSourceProvenance>
  ).reduce<SourceProvenance>(
    (all, section) => unionProvenance(all, provenanceForLatestSection(latest, section)),
    EMPTY_PROVENANCE,
  );
}
