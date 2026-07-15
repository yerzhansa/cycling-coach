import { describe, expect, it } from "vitest";
import { canonicalPick } from "../../src/ingest/canonical-pick.js";
import { xmlSessionsToCandidates } from "../../src/ingest/xml-candidate.js";
import type { XmlParseReport } from "../../src/ingest/xml-types.js";

const digest = "ab".repeat(32);

describe("XML candidate conversion", () => {
  it("maps every TCX concern without rounding and deep-copies arrays", () => {
    const report = {
      format: "tcx",
      quarantine: null,
      sessions: [{
        workoutOrdinal: 0,
        sessionOrdinal: 1,
        sport: "cycling",
        startUtc: 1.125,
        localDateKey: 19700101,
        elapsedS: 2.25,
        distanceM: 3.5,
        laps: [{ lapSeq: 0, startUtc: 1.125, elapsedS: 2.25, distanceM: 3.5, firstSampleIndex: 0, endSampleIndexExclusive: 2 }],
        segmentStartIndices: null,
        channels: { time: { timestamps: [1.125, 2.25], values: [1.125, 2.25] }, power: { timestamps: [1.125, 2.25], values: [100, null] } },
      }],
    } as const satisfies XmlParseReport<"tcx"> & { quarantine: null };
    const candidate = xmlSessionsToCandidates(report, digest)[0]!;
    expect(candidate).toMatchObject({ id: `tcx:${digest}:0:1`, origin: { kind: "file", format: "tcx", rawSha256: digest }, rank: 200 });
    expect(Object.keys(candidate).sort()).toEqual(["concerns", "id", "origin", "rank", "sessionOrdinal", "workoutOrdinal"]);
    expect(Object.keys(candidate.origin).sort()).toEqual(["format", "kind", "rawSha256"]);
    expect(candidate.concerns).toEqual({
      "session.sport": "cycling",
      "session.start_utc": 1.125,
      "session.local_date_key": 19700101,
      "session.elapsed_s": 2.25,
      "session.distance_m": 3.5,
      "session.is_transition": false,
      "lap[]": [{ lap_seq: 0, start_utc: 1.125, elapsed_s: 2.25, timer_s: null, distance_m: 3.5, summary_json: null }],
      "stream:time": { timestamps: [1.125, 2.25], values: [1.125, 2.25] },
      "stream:power": { timestamps: [1.125, 2.25], values: [100, null] },
    });
    expect(candidate.concerns["stream:time"]).not.toBe(report.sessions[0].channels.time);
    expect(Object.keys(candidate.concerns).some((key) => /workout|length|codec|sql/i.test(key))).toBe(false);
  });

  it("maps GPX segment summary and remains honestly not materializable", () => {
    const report = {
      format: "gpx",
      quarantine: null,
      sessions: [{ workoutOrdinal: 0, sessionOrdinal: 0, sport: null, startUtc: 1, localDateKey: 19700101, elapsedS: null, distanceM: null, laps: null, segmentStartIndices: [0, 3], channels: { time: { timestamps: [1], values: [1] }, lat: { timestamps: [1], values: [0] }, lng: { timestamps: [1], values: [0] } } }],
    } as const satisfies XmlParseReport<"gpx"> & { quarantine: null };
    const candidate = xmlSessionsToCandidates(report, digest)[0]!;
    expect(candidate.concerns["session.summary_json"]).toBe('{"segmentStartIndices":[0,3]}');
    expect(candidate.concerns).not.toHaveProperty("session.sport");
    expect(candidate.concerns).not.toHaveProperty("lap[]");
    expect(canonicalPick({ id: "g", candidates: [candidate], fitSerialByCandidateId: {} }).materialization).toEqual({ status: "not_materializable", reasons: ["missing_session_sport"] });
  });

  it("preserves multiple activity ordinals", () => {
    const base = { workoutOrdinal: 0 as const, sport: "cycling", startUtc: 1, localDateKey: 19700101, elapsedS: null, distanceM: null, laps: [], segmentStartIndices: null, channels: { time: { timestamps: [1], values: [1] } } };
    const report = { format: "tcx", quarantine: null, sessions: [{ ...base, sessionOrdinal: 0 }, { ...base, sessionOrdinal: 1 }] } satisfies XmlParseReport<"tcx"> & { quarantine: null };
    expect(xmlSessionsToCandidates(report, digest).map((candidate) => candidate.id)).toEqual([`tcx:${digest}:0:0`, `tcx:${digest}:0:1`]);
  });

  it("maps all nullable and omitted rows exactly for each XML format and rank", () => {
    const base = {
      workoutOrdinal: 0 as const,
      sessionOrdinal: 0,
      sport: null,
      startUtc: 1.5,
      localDateKey: 19700101,
      elapsedS: null,
      distanceM: null,
      laps: null,
      segmentStartIndices: [0],
      channels: { time: { timestamps: [1.5], values: [1.5] } },
    };
    const gpxReport = { format: "gpx", quarantine: null, sessions: [base] } satisfies XmlParseReport<"gpx"> & { quarantine: null };
    const gpxCandidate = xmlSessionsToCandidates(gpxReport, digest)[0]!;
    expect(gpxCandidate.rank).toBe(100);
    expect(gpxCandidate.concerns).toEqual({
      "session.start_utc": 1.5,
      "session.local_date_key": 19700101,
      "session.is_transition": false,
      "session.summary_json": '{"segmentStartIndices":[0]}',
      "stream:time": { timestamps: [1.5], values: [1.5] },
    });
    for (const omitted of ["session.sport", "session.sub_sport", "session.tz_offset_s", "session.elapsed_s", "session.timer_s", "session.moving_s", "session.distance_m", "lap[]", "swim_length[]"]) {
      expect(gpxCandidate.concerns).not.toHaveProperty(omitted);
    }

    const tcxReport = {
      format: "tcx",
      quarantine: null,
      sessions: [{ ...base, sport: "other", elapsedS: 0.25, distanceM: 0.5, laps: [], segmentStartIndices: null }],
    } satisfies XmlParseReport<"tcx"> & { quarantine: null };
    const tcxCandidate = xmlSessionsToCandidates(tcxReport, digest)[0]!;
    expect(tcxCandidate.rank).toBe(200);
    expect(tcxCandidate.concerns).toMatchObject({
      "session.sport": "other",
      "session.elapsed_s": 0.25,
      "session.distance_m": 0.5,
      "lap[]": [],
    });
    expect(tcxCandidate.concerns).not.toHaveProperty("session.summary_json");
  });

  it("deep-copies every channel and lap while leaving the input DTO unchanged", () => {
    const report = {
      format: "tcx",
      quarantine: null,
      sessions: [{
        workoutOrdinal: 0,
        sessionOrdinal: 0,
        sport: "cycling",
        startUtc: 1.125,
        localDateKey: 19700101,
        elapsedS: null,
        distanceM: 2.75,
        laps: [{ lapSeq: 0, startUtc: 1.125, elapsedS: null, distanceM: 2.75, firstSampleIndex: 0, endSampleIndexExclusive: 1 }],
        segmentStartIndices: null,
        channels: { time: { timestamps: [1.125], values: [1.125] }, distance: { timestamps: [1.125], values: [2.75] } },
      }],
    } satisfies XmlParseReport<"tcx"> & { quarantine: null };
    const before = structuredClone(report);
    const candidate = xmlSessionsToCandidates(report, digest)[0]!;
    expect(report).toEqual(before);
    (candidate.concerns["stream:distance"] as { timestamps: number[]; values: (number | null)[] }).values[0] = 999;
    (candidate.concerns["lap[]"] as unknown as { distance_m: number | null }[])[0]!.distance_m = 999;
    expect(report).toEqual(before);
  });

  it("exercises file identity and rank validation through the canonical boundary", () => {
    const report = {
      format: "gpx",
      quarantine: null,
      sessions: [{ workoutOrdinal: 0, sessionOrdinal: 0, sport: null, startUtc: 1, localDateKey: 19700101, elapsedS: null, distanceM: null, laps: null, segmentStartIndices: [0], channels: { time: { timestamps: [1], values: [1] }, lat: { timestamps: [1], values: [0] }, lng: { timestamps: [1], values: [0] } } }],
    } satisfies XmlParseReport<"gpx"> & { quarantine: null };
    const candidate = xmlSessionsToCandidates(report, digest)[0]!;
    expect(canonicalPick({ id: "g", candidates: [candidate], fitSerialByCandidateId: {} }).groupId).toBe("g");
    expect(() => canonicalPick({ id: "g", candidates: [{ ...candidate, id: "gpx:bad:0:0" }], fitSerialByCandidateId: {} })).toThrowError("Candidate identity is invalid.");
    expect(() => canonicalPick({ id: "g", candidates: [{ ...candidate, rank: 200 }], fitSerialByCandidateId: {} })).toThrowError("Candidate quality rank is invalid.");
  });
});
