import { describe, expect, it } from "vitest";
import { planBrickAdjacency, planBrickAdjacencyFromTopology, planDedup, type Candidate, type DedupCandidateSummary } from "../src/ingest/index.js";
import type { DedupConfirmationRow } from "../src/store/index.js";

const member = (n: number) => n.toString(16).padStart(64, "0");
function item(n: number, family: string, start: number, duration = 100, options: { transition?: boolean; platform?: boolean } = {}) {
  const raw = member(n), kind = options.platform ? "platform_api" : "fit";
  const candidateId = options.platform ? `platform_api:${raw}:0:0` : `fit:${raw}:0:0`;
  const candidate: Candidate = { id: candidateId, origin: options.platform
    ? { kind: "platform", source: "intervals-icu", sourceRecordId: raw, persistedQualityRank: 300 }
    : { kind: "file", format: "fit", rawSha256: raw }, workoutOrdinal: 0, sessionOrdinal: 0,
    rank: options.platform ? 300 : 400, concerns: {} };
  const summary: DedupCandidateSummary = { candidate_id: candidateId, member_id: raw, source_kind: kind,
    source_session_seq: 0, sport_family: family, is_transition: options.transition ?? false, start_utc: start,
    duration_s: duration, distance_m: null, file_id_manufacturer: null, file_id_serial: n,
    file_id_time_created_utc: null };
  return { candidate, summary };
}
function bricks(values: ReturnType<typeof item>[], confirmations: DedupConfirmationRow[] = [], settings: { sport: string; session_cluster_conventions_json: string | null }[] = []) {
  return planBrickAdjacency(planDedup(values.map((v) => v.candidate), values.map((v) => v.summary), confirmations), settings);
}

describe("brick adjacency", () => {
  it("[PR05-BRICK-001] accepts 900 seconds and rejects 901", () => {
    expect(bricks([item(1, "cycling", 0), item(2, "running", 1_000)]).brick_groups).toHaveLength(1);
    expect(bricks([item(1, "cycling", 0), item(2, "running", 1_001)]).brick_groups).toHaveLength(0);
  });
  it("[PR05-BRICK-002] rejects negative gaps, same families, and transitions", () => {
    expect(bricks([item(1, "cycling", 0), item(2, "running", 50)]).brick_groups).toHaveLength(0);
    expect(bricks([item(1, "cycling", 0), item(2, "cycling", 200)]).brick_groups).toHaveLength(0);
    expect(bricks([item(1, "cycling", 0, 100, { transition: true }), item(2, "running", 200)]).brick_groups).toHaveLength(0);
  });
  it("[PR05-BRICK-003] applies an outgoing override and ignores additive keys", () => {
    const result = bricks([item(1, "cycling", 0), item(2, "running", 1_600)], [], [
      { sport: "cycling", session_cluster_conventions_json: '{"transition_window_s":1500,"future":true}' },
    ]);
    expect(result.brick_groups[0]!.effective_transition_window_s).toBe(1_500);
  });
  it("[PR05-BRICK-004] fails closed on malformed settings", () => {
    for (const value of ["{", "[]", "null", '{"transition_window_s":null}', '{"transition_window_s":1.5}', '{"transition_window_s":-1}']) {
      expect(() => bricks([item(1, "cycling", 0), item(2, "running", 200)], [], [{ sport: "cycling", session_cluster_conventions_json: value }])).toThrow();
    }
  });
  it("[PR05-BRICK-005] forms an order-invariant connected three-leg group", () => {
    const values = [item(1, "running", 0), item(2, "cycling", 200), item(3, "running", 400)];
    expect(bricks(values).workouts).toHaveLength(1);
    expect(bricks([...values].reverse())).toEqual(bricks(values));
  });
  it("[PR05-BRICK-006] never skips an intervening ineligible session", () => {
    const result = bricks([item(1, "running", 0), item(2, "transition", 150, 10, { transition: true }), item(3, "cycling", 200)]);
    expect(result.brick_groups).toHaveLength(0);
  });
  it("[PR05-BRICK-007] requires disjoint nonempty file sets and honors all-member cannot-links", () => {
    expect(bricks([item(1, "running", 0, 100, { platform: true }), item(2, "cycling", 200)]).brick_groups).toHaveLength(0);
    const distinct: DedupConfirmationRow = { id: "0".repeat(26), member_a: member(1), member_b: member(2), verdict: "distinct",
      device_id: "d", hlc_physical_ms: 1, hlc_counter: 0 };
    expect(bricks([item(1, "running", 0), item(2, "cycling", 200)], [distinct]).brick_groups).toHaveLength(0);
  });
  it("[PR05-BRICK-008] preserves chronological report tuple orientation", () => {
    const result = bricks([item(9, "running", 0), item(1, "cycling", 200)]);
    expect(result.brick_groups[0]).toMatchObject({ members: [member(9), member(1)], families: ["running", "cycling"] });
  });
  it("keeps the lightweight topology adapter byte-equivalent to the public planner", () => {
    const values = [item(1, "running", 0), item(2, "cycling", 200), item(3, "running", 400)];
    const dedup = planDedup(values.map((value) => value.candidate), values.map((value) => value.summary), []);
    expect(planBrickAdjacencyFromTopology(dedup, [])).toEqual(planBrickAdjacency(dedup, []));
  });
});
