import { describe, expect, it } from "vitest";
import { rescalePoolDistances } from "../src/ingest/pool-size-rescale.js";
import { cloneMappedFitArtifactForRebuild } from "../src/ingest/rebuild.js";
import type { MappedFitArtifact } from "../src/ingest/types.js";

const mixed = [
  { lengthKey: "a", lengthType: "active" },
  { lengthKey: "idle", lengthType: "idle" },
  { lengthKey: "b", lengthType: "active" },
] as const;
const four = [
  { lengthKey: "l0", lengthType: "active" },
  { lengthKey: "l1", lengthType: "active" },
  { lengthKey: "l2", lengthType: "active" },
  { lengthKey: "l3", lengthType: "active" },
] as const;

describe("pool size rescale", () => {
  it("derives active and idle baseline distances", () => {
    expect(rescalePoolDistances({ sourceSessionDistanceM: 100, lengths: mixed, correctedPoolLengthM: null })).toEqual({
      sessionDistanceM: 100,
      lengths: [{ lengthKey: "a", distanceM: 50 }, { lengthKey: "idle", distanceM: 0 }, { lengthKey: "b", distanceM: 50 }],
    });
  });
  it("applies one correction multiplier", () => {
    expect(rescalePoolDistances({ sourceSessionDistanceM: 100, lengths: mixed, correctedPoolLengthM: 25 })).toEqual({
      sessionDistanceM: 50,
      lengths: [{ lengthKey: "a", distanceM: 25 }, { lengthKey: "idle", distanceM: 0 }, { lengthKey: "b", distanceM: 25 }],
    });
  });
  it("rescales four lengths from 100 to 200", () => {
    expect(rescalePoolDistances({ sourceSessionDistanceM: 100, lengths: four, correctedPoolLengthM: 50 })).toEqual({
      sessionDistanceM: 200,
      lengths: four.map((length) => ({ lengthKey: length.lengthKey, distanceM: 50 })),
    });
  });
  it("retains exact unrounded real results", () => {
    expect(rescalePoolDistances({ sourceSessionDistanceM: 100, lengths: four, correctedPoolLengthM: 22.86 })).toEqual({
      sessionDistanceM: 91.44,
      lengths: four.map((length) => ({ lengthKey: length.lengthKey, distanceM: 22.86 })),
    });
  });
  it("treats drill-normalized active lengths as active", () => {
    expect(rescalePoolDistances({ sourceSessionDistanceM: 25, lengths: [{ lengthKey: "drill", lengthType: "active" }], correctedPoolLengthM: null })).toEqual({
      sessionDistanceM: 25,
      lengths: [{ lengthKey: "drill", distanceM: 25 }],
    });
  });
  it("leaves underivable distances null and refuses corrections", () => {
    const cases = [
      { sourceSessionDistanceM: null, lengths: [{ lengthKey: "a", lengthType: "active" as const }], expected: { sessionDistanceM: null, lengths: [{ lengthKey: "a", distanceM: null }] } },
      { sourceSessionDistanceM: 0, lengths: [{ lengthKey: "a", lengthType: "active" as const }], expected: { sessionDistanceM: 0, lengths: [{ lengthKey: "a", distanceM: null }] } },
      { sourceSessionDistanceM: 100, lengths: [{ lengthKey: "idle", lengthType: "idle" as const }], expected: { sessionDistanceM: 100, lengths: [{ lengthKey: "idle", distanceM: null }] } },
    ];
    for (const entry of cases) {
      expect(rescalePoolDistances({ ...entry, correctedPoolLengthM: null })).toEqual(entry.expected);
      expect(() => rescalePoolDistances({ ...entry, correctedPoolLengthM: 25 })).toThrow();
    }
  });
  it("validates inputs, normalizes negative zero, preserves input, and returns deep-new values", () => {
    const sparse = [{ lengthKey: "a", lengthType: "active" as const }, { lengthKey: "b", lengthType: "active" as const }];
    delete sparse[0];
    const extra = [{ lengthKey: "a", lengthType: "active" as const }] as typeof sparse & { extra?: number };
    extra.extra = 1;
    const accessor = [{ lengthKey: "a", lengthType: "active" as const }];
    Object.defineProperty(accessor, "0", { get: () => ({ lengthKey: "a", lengthType: "active" }), enumerable: true });
    for (const input of [
      { sourceSessionDistanceM: -1, lengths: mixed, correctedPoolLengthM: null },
      { sourceSessionDistanceM: Infinity, lengths: mixed, correctedPoolLengthM: null },
      { sourceSessionDistanceM: 1, lengths: mixed, correctedPoolLengthM: 0 },
      { sourceSessionDistanceM: 1, lengths: mixed, correctedPoolLengthM: -1 },
      { sourceSessionDistanceM: 1, lengths: mixed, correctedPoolLengthM: Infinity },
      { sourceSessionDistanceM: 1, lengths: [{ lengthKey: "x", lengthType: "other" as never }], correctedPoolLengthM: null },
      { sourceSessionDistanceM: 1, lengths: [{ lengthKey: "", lengthType: "active" as const }], correctedPoolLengthM: null },
      { sourceSessionDistanceM: Number.MIN_VALUE, lengths: [{ lengthKey: "a", lengthType: "active" as const }], correctedPoolLengthM: Number.MAX_VALUE },
      { sourceSessionDistanceM: 1, lengths: {} as never, correctedPoolLengthM: null },
      { sourceSessionDistanceM: 1, lengths: sparse, correctedPoolLengthM: null },
      { sourceSessionDistanceM: 1, lengths: extra, correctedPoolLengthM: null },
      { sourceSessionDistanceM: 1, lengths: accessor, correctedPoolLengthM: null },
    ]) expect(() => rescalePoolDistances(input)).toThrow();
    const input = { sourceSessionDistanceM: -0, lengths: [{ lengthKey: "z", lengthType: "active" as const }], correctedPoolLengthM: null };
    const before = structuredClone(input);
    const output = rescalePoolDistances(input);
    expect(output).toEqual({ sessionDistanceM: 0, lengths: [{ lengthKey: "z", distanceM: null }] });
    expect(Object.is(output.sessionDistanceM, -0)).toBe(false);
    expect(input).toEqual(before);
    expect(output).not.toBe(input);
    expect(output.lengths).not.toBe(input.lengths);
    expect(output.lengths[0]).not.toBe(input.lengths[0]);

    const artifact: MappedFitArtifact = {
      rawFile: { sha256: "01".repeat(32), path: "x.fit", ext: "fit", bytes: 3, file_id_serial: 1, file_id_time_created_utc: 2, manufacturer: "m", product: "p" },
      logicalArchiveEpochSeconds: 2,
      activity: {
        workout: { workout_key: "w", start_utc: 1, tz_offset_s: null, name: null, notes: null, is_multisport: 0, dedup_cluster_id: "d" },
        sessions: [{ session_key: "s", workout_key: "w", session_seq: 0, sport: "swimming", sub_sport: "lap_swimming", start_utc: 1, tz_offset_s: null, local_date_key: 19700101, elapsed_s: 1, timer_s: 1, moving_s: 1, distance_m: 25, is_transition: 0, summary_json: null }],
        laps: [{ lap_key: "lap", session_key: "s", lap_seq: 0, start_utc: 1, elapsed_s: 1, timer_s: 1, distance_m: 25, summary_json: null }],
        swimLengths: [{ length_key: "length", lap_key: "lap", length_seq: 0, start_utc: 1, elapsed_s: 1, timer_s: 1, strokes: 1, stroke_type: "freestyle", length_type: "active", distance_m: 25 }],
        streams: [{ stream_key: "stream", session_key: "s", channel: "time", encoding: "f64:raw:zdeflate:le", sample_rate: null, n: 1, data: new Uint8Array([1, 2, 3]) }],
        repairLogs: [{ sessionKey: "s", fixer: "pulseWeave", channel: "heart_rate", changedIndices: [1, 2], params: { boundaryPolicy: "bounded-only", convergence: "fixed-point", flatlineBoundaryDeltaBpm: 5, flatlineMinSeconds: 10, interpolation: "linear", maxRepairSeconds: 30, plausibleBpm: [35, 230], zeroOrImplausibleMaxBpm: 30, zeroRunMinSeconds: 2 } }],
        poolSessions: [{ sessionKey: "s", sourceSessionDistanceM: 25, lengths: [{ lengthKey: "length", lengthType: "active" }] }],
      },
    };
    const artifactBefore = structuredClone(artifact);
    const cloned = cloneMappedFitArtifactForRebuild(artifact);
    expect(cloned).toEqual(artifact);
    expect(artifact).toEqual(artifactBefore);
    expect(cloned).not.toBe(artifact);
    expect(cloned.rawFile).not.toBe(artifact.rawFile);
    expect(cloned.activity).not.toBe(artifact.activity);
    expect(cloned.activity.workout).not.toBe(artifact.activity.workout);
    for (const key of ["sessions", "laps", "swimLengths", "streams", "repairLogs", "poolSessions"] as const) {
      expect(cloned.activity[key]).not.toBe(artifact.activity[key]);
      expect(cloned.activity[key][0]).not.toBe(artifact.activity[key][0]);
    }
    expect(cloned.activity.streams[0]!.data).not.toBe(artifact.activity.streams[0]!.data);
    expect(cloned.activity.repairLogs[0]!.changedIndices).not.toBe(artifact.activity.repairLogs[0]!.changedIndices);
    expect(cloned.activity.repairLogs[0]!.params).not.toBe(artifact.activity.repairLogs[0]!.params);
    expect((cloned.activity.repairLogs[0]!.params as { plausibleBpm: readonly number[] }).plausibleBpm)
      .not.toBe((artifact.activity.repairLogs[0]!.params as { plausibleBpm: readonly number[] }).plausibleBpm);
    expect(cloned.activity.poolSessions[0]!.lengths).not.toBe(artifact.activity.poolSessions[0]!.lengths);
    expect(cloned.activity.poolSessions[0]!.lengths[0]).not.toBe(artifact.activity.poolSessions[0]!.lengths[0]);
  });
});
