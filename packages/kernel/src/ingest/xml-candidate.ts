import type { Candidate, ConcernValue, LapConcern } from "./canonical-pick.js";
import { qualityRankForFile } from "./quality-rank.js";
import type { XmlParseReport } from "./xml-types.js";

export function xmlSessionsToCandidates<F extends "tcx" | "gpx">(
  report: XmlParseReport<F> & { readonly quarantine: null },
  rawSha256: string,
): readonly Candidate[] {
  return report.sessions.map((session) => {
    const concerns: Record<string, ConcernValue> = {};
    if (session.sport !== null) concerns["session.sport"] = session.sport;
    concerns["session.start_utc"] = session.startUtc;
    concerns["session.local_date_key"] = session.localDateKey;
    if (session.elapsedS !== null) concerns["session.elapsed_s"] = session.elapsedS;
    if (session.distanceM !== null) concerns["session.distance_m"] = session.distanceM;
    concerns["session.is_transition"] = false;
    if (session.segmentStartIndices !== null) {
      concerns["session.summary_json"] = `{"segmentStartIndices":[${session.segmentStartIndices.join(",")}]}`;
    }
    if (session.laps !== null) {
      concerns["lap[]"] = session.laps.map((lap): LapConcern => ({
        lap_seq: lap.lapSeq,
        start_utc: lap.startUtc,
        elapsed_s: lap.elapsedS,
        timer_s: null,
        distance_m: lap.distanceM,
        summary_json: null,
      }));
    }
    for (const [name, channel] of Object.entries(session.channels)) {
      concerns[`stream:${name}`] = {
        timestamps: [...channel.timestamps],
        values: [...channel.values],
      };
    }
    const id = `${report.format}:${rawSha256}:${session.workoutOrdinal}:${session.sessionOrdinal}`;
    return {
      id,
      origin: { kind: "file", format: report.format, rawSha256 },
      workoutOrdinal: session.workoutOrdinal,
      sessionOrdinal: session.sessionOrdinal,
      rank: qualityRankForFile(report.format),
      concerns,
    };
  });
}
