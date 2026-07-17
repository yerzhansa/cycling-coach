import { describe, expect, it } from "vitest";
import {
  DEFAULT_TIER3_THRESHOLDS,
  planDedup,
  ratioDelta,
  type Candidate,
  type DedupCandidateSummary,
} from "../src/ingest/index.js";
import type { DedupConfirmationRow } from "../src/store/index.js";

const member = (value: number): string => value.toString(16).padStart(64, "0");
function presentation(id: number, overrides: Partial<DedupCandidateSummary> = {}): { candidate: Candidate; summary: DedupCandidateSummary } {
  const raw = overrides.member_id ?? member(id);
  const candidateId = overrides.candidate_id ?? `fit:${raw}:0:0`;
  return {
    candidate: { id: candidateId, origin: { kind: "file", format: "fit", rawSha256: raw }, workoutOrdinal: 0,
      sessionOrdinal: Number(candidateId.split(":").at(-1)), rank: 400, concerns: {} },
    summary: { candidate_id: candidateId, member_id: raw, source_kind: "fit", source_session_seq: 0,
      sport_family: "cycling", is_transition: false, start_utc: 1_000, duration_s: 1_000, distance_m: 10_000,
      file_id_manufacturer: "m", file_id_serial: 7, file_id_time_created_utc: 900, ...overrides },
  };
}
function plan(values: readonly ReturnType<typeof presentation>[], confirmations: readonly DedupConfirmationRow[] = []) {
  return planDedup(values.map((value) => value.candidate), values.map((value) => value.summary), confirmations);
}
const thresholdPresentation = (id: number, overrides: Partial<DedupCandidateSummary> = {}) =>
  presentation(id, { file_id_manufacturer: null, ...overrides });
function confirmation(a: string, b: string, verdict: "merge" | "distinct", counter = 0): DedupConfirmationRow {
  return { id: `${counter}`.padStart(26, "0"), member_a: a < b ? a : b, member_b: a < b ? b : a,
    verdict, device_id: "device", hlc_physical_ms: 1, hlc_counter: counter };
}

describe("dedup tiers", () => {
  it("[PR05-U13-001] accepts exact inclusive boundaries", () => {
    const a = thresholdPresentation(1), b = thresholdPresentation(2, { start_utc: 1_120, duration_s: 1_100, distance_m: 11_000 });
    expect(plan([a, b]).sessions).toHaveLength(1);
    expect(DEFAULT_TIER3_THRESHOLDS).toEqual({ startSeconds: 120, durationPercent: 10, distancePercent: 10, containmentSlackSeconds: 120, nearMissMultiplier: 2 });
  });
  it("[PR05-U13-002] rejects a 121 second start delta", () => {
    expect(plan([thresholdPresentation(1), thresholdPresentation(2, { start_utc: 1_121 })]).sessions).toHaveLength(2);
  });
  it("[PR05-U13-003] rejects duration plus 10.01 percent", () => {
    expect(plan([thresholdPresentation(1), thresholdPresentation(2, { duration_s: 1_100.1 })]).sessions).toHaveLength(2);
  });
  it("[PR05-U13-004] rejects distance plus 10.01 percent", () => {
    expect(plan([thresholdPresentation(1), thresholdPresentation(2, { distance_m: 11_001 })]).sessions).toHaveLength(2);
  });
  it("[PR05-U13-005] treats a missing distance as untested", () => {
    const result = plan([thresholdPresentation(1), thresholdPresentation(2, { distance_m: null, file_id_serial: 8 })]);
    expect(result.confirm_queue[0]).toMatchObject({ distance_ratio: null, distance_ratio_state: "untested", distance_untested: true });
  });
  it("[PR05-U13-006] tags zero and invalid ratio inputs", () => {
    expect(ratioDelta(0, 0)).toEqual({ state: "value", value: 0 });
    expect(ratioDelta(0, 1)).toEqual({ state: "one_zero", value: null });
    expect(ratioDelta(-1, 1).state).toBe("invalid_input");
    expect(ratioDelta(Number.POSITIVE_INFINITY, 1).state).toBe("invalid_input");
  });
  it("[PR05-U13-007] does not let containment waive ratios", () => {
    const b = thresholdPresentation(2, { start_utc: 1_500, duration_s: 500, distance_m: 20_000 });
    expect(plan([thresholdPresentation(1), b]).sessions).toHaveLength(2);
  });
  it("[PR05-U13-008] separates strict matching from the doubled envelope", () => {
    const result = plan([thresholdPresentation(1), thresholdPresentation(2, { start_utc: 1_180, duration_s: 1_150 })]);
    expect(result.sessions).toHaveLength(2); expect(result.threshold_near_misses).toHaveLength(1);
  });
  it("[PR05-U13-009] reports expanded overlap beyond the near-miss envelope", () => {
    const result = plan([thresholdPresentation(1), thresholdPresentation(2, { start_utc: 2_100, duration_s: 1_000 })]);
    expect(result.threshold_near_misses).toEqual([]); expect(result.overlap_watchlist).toHaveLength(1);
  });
  it("[PR05-U13-010] serializes one-zero overlap diagnostics without non-finite values", () => {
    const result = plan([thresholdPresentation(1, { duration_s: 0, distance_m: 0 }), thresholdPresentation(2, { duration_s: 1, distance_m: 1 })]);
    expect(result.overlap_watchlist[0]).toMatchObject({ duration_ratio: null, duration_ratio_failed: true, distance_ratio: null, distance_ratio_state: "one_zero" });
    expect(JSON.stringify(result)).not.toContain("Infinity");
  });
  it("[PR05-GRAPH-001] merges an equal-serial direct edge", () => {
    expect(plan([presentation(1, { file_id_manufacturer: null }), presentation(2, { file_id_manufacturer: null })]).sessions[0]!.edge_tiers).toEqual(["tier3"]);
  });
  it("[PR05-GRAPH-002] queues different and present-absent serial pairs", () => {
    expect(plan([presentation(1), presentation(2, { file_id_serial: 8 })]).confirm_queue).toHaveLength(1);
    expect(plan([presentation(1), presentation(2, { file_id_serial: null })]).confirm_queue).toHaveLength(1);
  });
  it("merges API plus FIT at Tier 3 without consulting serial confirmation", () => {
    const fit = presentation(1, { file_id_manufacturer: null, file_id_serial: 7 });
    const platformMember = member(2);
    const platformId = `platform_api:${platformMember}:0:0`;
    const api = {
      candidate: { id: platformId, origin: { kind: "platform" as const, source: "intervals-icu" as const,
        sourceRecordId: platformMember, persistedQualityRank: 300 }, workoutOrdinal: 0, sessionOrdinal: 0,
        rank: 300 as const, concerns: {} },
      summary: { ...fit.summary, candidate_id: platformId, member_id: platformMember,
        source_kind: "platform_api" as const, file_id_manufacturer: null, file_id_serial: null,
        file_id_time_created_utc: null },
    };
    const result = plan([api, fit], [confirmation(api.summary.member_id, fit.summary.member_id, "distinct")]);
    expect(result.confirm_queue).toEqual([]);
    expect(result.sessions).toHaveLength(2);
    expect(plan([api, fit]).sessions[0]!.edge_tiers).toEqual(["tier3"]);
  });
  it("[PR05-GRAPH-003] enforces a component-wide authored distinct verdict", () => {
    const a = presentation(1), b = presentation(2), c = presentation(3);
    const result = plan([a, b, c], [confirmation(a.summary.member_id, c.summary.member_id, "distinct")]);
    expect(result.sessions).toHaveLength(2);
    const a0 = presentation(4, { candidate_id: `fit:${member(4)}:0:0`, source_session_seq: 0, start_utc: 1_000 });
    const b0 = presentation(5, { candidate_id: `fit:${member(5)}:0:0`, source_session_seq: 0, start_utc: 1_000 });
    const a1 = presentation(4, { candidate_id: `fit:${member(4)}:0:1`, source_session_seq: 1, start_utc: 3_000 });
    const c1 = presentation(6, { candidate_id: `fit:${member(6)}:0:1`, source_session_seq: 1, start_utc: 3_000 });
    const sharedMember = plan([a0, b0, a1, c1], [confirmation(b0.summary.member_id, c1.summary.member_id, "distinct")]);
    expect(sharedMember.sessions).toHaveLength(2);
    expect(sharedMember.workouts).toHaveLength(2);
  });
  it("[PR05-GRAPH-004] chooses the lexicographically smallest cluster member", () => {
    expect(plan([presentation(9), presentation(2)]).workouts[0]!.members[0]).toBe(member(2));
  });
  it("[PR05-GRAPH-005] is invariant over 100 deterministic input shuffles", () => {
    const values = [presentation(1), presentation(2), presentation(3)];
    const expected = JSON.stringify(plan(values));
    for (let index = 0; index < 100; index += 1) {
      const rotated = [...values.slice(index % 3), ...values.slice(0, index % 3)];
      if (index % 2) rotated.reverse();
      expect(JSON.stringify(plan(rotated))).toBe(expected);
    }
  });
  it("[PR05-GRAPH-006] requires a complete equal FIT tuple and session sequence", () => {
    const far = presentation(2, { start_utc: 9_000 });
    expect(plan([presentation(1), far]).sessions).toHaveLength(1);
    expect(plan([presentation(1), presentation(2, { start_utc: 9_000, source_session_seq: 1 })]).sessions).toHaveLength(2);
    expect(plan([presentation(1), presentation(2, { start_utc: 9_000, file_id_manufacturer: null })]).sessions).toHaveLength(2);
  });
  it("[PR05-GRAPH-007] reports Tier 2 only when both Tier 2 and Tier 3 qualify", () => {
    expect(plan([presentation(1), presentation(2)]).sessions[0]!.edge_tiers).toEqual(["tier2"]);
  });
  it("[PR05-GRAPH-008] omits redundant cycle labels", () => {
    const result = plan([presentation(1, { file_id_manufacturer: null }), presentation(2, { file_id_manufacturer: null }), presentation(3, { file_id_manufacturer: null })]);
    expect(result.sessions).toHaveLength(1); expect(result.sessions[0]!.edge_tiers).toEqual(["tier3"]);
  });
  it("[PR05-GRAPH-009] keeps close same-file repeated sessions separate", () => {
    const raw = member(1);
    const a = presentation(1, { candidate_id: `fit:${raw}:0:0`, source_session_seq: 0 });
    const b = presentation(1, { candidate_id: `fit:${raw}:0:1`, source_session_seq: 1, start_utc: 1_020 });
    expect(plan([a, b]).sessions).toHaveLength(2); expect(plan([a, b]).workouts).toHaveLength(1);
  });
  it("[PR05-GRAPH-010] preserves side metadata under inverse lexical candidate order", () => {
    const a = presentation(1, { candidate_id: `fit:${member(1)}:0:9`, file_id_serial: 9 });
    const b = presentation(2, { candidate_id: `fit:${member(2)}:0:0`, file_id_serial: 8 });
    expect(plan([b, a]).confirm_queue[0]).toMatchObject({ member_a: member(1), candidate_a: a.summary.candidate_id, serial_a: 9 });
  });
  it("[PR05-GRAPH-011] uses deterministic one-to-one matching for a member pair", () => {
    const a0 = presentation(1), a1 = presentation(1, { candidate_id: `fit:${member(1)}:0:1`, source_session_seq: 1, start_utc: 2_000 });
    const b0 = presentation(2, { file_id_serial: 8 }), b1 = presentation(2, { candidate_id: `fit:${member(2)}:0:1`, source_session_seq: 1, start_utc: 2_000, file_id_serial: 8 });
    const result = plan([a1, b0, a0, b1], [confirmation(member(1), member(2), "merge")]);
    expect(result.sessions).toHaveLength(2); expect(result.confirm_queue).toEqual([]);
    expect(result.applied_confirmations[0]!.result).toBe("edge_authorized");
  });
  it("[PR05-GRAPH-012] reports a stale merge with no selected edge", () => {
    const result = plan([presentation(1), presentation(2, { start_utc: 9_000, file_id_serial: 8 })], [confirmation(member(1), member(2), "merge")]);
    expect(result.applied_confirmations[0]!.result).toBe("no_matching_candidate_edge");
  });
  it("[PR05-GRAPH-013] retains an unmatched near miss for an already matched member pair", () => {
    const a0 = presentation(1), b0 = presentation(2);
    const a1 = presentation(1, { candidate_id: `fit:${member(1)}:0:1`, source_session_seq: 1, start_utc: 3_000, file_id_manufacturer: null });
    const b1 = presentation(2, { candidate_id: `fit:${member(2)}:0:1`, source_session_seq: 1, start_utc: 3_180, duration_s: 1_150, file_id_manufacturer: null });
    expect(plan([a0, b0, a1, b1]).threshold_near_misses).toHaveLength(1);
  });
  it("[PR05-GRAPH-014] has no Tier-4 or fingerprint production surface", async () => {
    const source = await import("node:fs/promises").then((fs) => fs.readFile("packages/kernel/src/ingest/dedup.ts", "utf8"));
    expect(source.toLowerCase()).not.toMatch(/tier.?4|fingerprint|downsample.*hash|hash.*downsample/);
  });
});
