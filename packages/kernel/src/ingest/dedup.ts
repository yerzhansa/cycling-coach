import type { Candidate, LogicalSessionGroup } from "./canonical-pick.js";
import type { DedupConfirmationRow } from "../store/ports.js";

export const DEFAULT_TIER3_THRESHOLDS = {
  startSeconds: 120,
  durationPercent: 10,
  distancePercent: 10,
  containmentSlackSeconds: 120,
  nearMissMultiplier: 2,
} as const;

export interface DedupCandidateSummary {
  readonly candidate_id: string;
  readonly member_id: string;
  readonly source_kind: "fit" | "tcx" | "gpx" | "platform_api";
  readonly source_session_seq: number;
  readonly sport_family: string;
  readonly is_transition: boolean;
  readonly start_utc: number;
  readonly duration_s: number;
  readonly distance_m: number | null;
  readonly file_id_manufacturer: string | null;
  readonly file_id_serial: number | null;
  readonly file_id_time_created_utc: number | null;
}

export interface PairDiagnostic {
  readonly member_a: string;
  readonly member_b: string;
  readonly candidate_a: string;
  readonly candidate_b: string;
  readonly serial_a: number | null;
  readonly serial_b: number | null;
  readonly start_delta_s: number;
  readonly duration_ratio: number | null;
  readonly duration_ratio_failed: boolean;
  readonly distance_ratio: number | null;
  readonly distance_ratio_state: "value" | "one_zero" | "untested";
  readonly containment: boolean;
  readonly distance_untested: boolean;
  readonly reason: string;
}

export interface OverlapDiagnostic extends PairDiagnostic {
  readonly expanded_a: { readonly start_utc: number; readonly end_utc: number };
  readonly expanded_b: { readonly start_utc: number; readonly end_utc: number };
}

export interface AppliedConfirmationReport {
  readonly id: string;
  readonly member_a: string;
  readonly member_b: string;
  readonly verdict: "merge" | "distinct";
  readonly hlc_physical_ms: number;
  readonly hlc_counter: number;
  readonly device_id: string;
  readonly result: "edge_authorized" | "cannot_link_applied" | "no_matching_candidate_edge" | "orphaned" | "superseded";
  readonly reason: string;
}

export type RatioDelta =
  | { readonly state: "value"; readonly value: number }
  | { readonly state: "one_zero"; readonly value: null }
  | { readonly state: "invalid_input"; readonly value: null };

export function ratioDelta(a: number, b: number): RatioDelta {
  if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b < 0) return { state: "invalid_input", value: null };
  if (a === 0 && b === 0) return { state: "value", value: 0 };
  if (a === 0 || b === 0) return { state: "one_zero", value: null };
  return { state: "value", value: Math.max(a, b) / Math.min(a, b) - 1 };
}

function compareText(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function pairKey(a: string, b: string): string { return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`; }

function validateSummary(summary: DedupCandidateSummary): void {
  if (!/^[0-9a-f]{64}$/.test(summary.member_id) || summary.candidate_id.length === 0 || summary.sport_family.length === 0) {
    throw new TypeError("invalid dedup identity");
  }
  for (const value of [summary.start_utc, summary.duration_s]) {
    if (!Number.isFinite(value) || value < 0) throw new TypeError("invalid dedup numeric value");
  }
  if (summary.distance_m !== null && (!Number.isFinite(summary.distance_m) || summary.distance_m < 0)) {
    throw new TypeError("invalid dedup distance");
  }
  if (!Number.isSafeInteger(summary.source_session_seq) || summary.source_session_seq < 0) {
    throw new TypeError("invalid source session sequence");
  }
  for (const value of [summary.file_id_serial, summary.file_id_time_created_utc]) {
    if (value !== null && (!Number.isSafeInteger(value) || value < 0)) throw new TypeError("invalid FIT identity");
  }
}

function orient(left: DedupCandidateSummary, right: DedupCandidateSummary): readonly [DedupCandidateSummary, DedupCandidateSummary] {
  const order = compareText(left.member_id, right.member_id) || compareText(left.candidate_id, right.candidate_id);
  return order <= 0 ? [left, right] : [right, left];
}

function containment(left: DedupCandidateSummary, right: DedupCandidateSummary, slack: number): boolean {
  const [early, late] = left.start_utc < right.start_utc
    || (left.start_utc === right.start_utc && left.candidate_id < right.candidate_id)
    ? [left, right] : [right, left];
  const earlyEnd = early.start_utc + early.duration_s;
  const lateEnd = late.start_utc + late.duration_s;
  return late.duration_s <= early.duration_s
    && lateEnd - earlyEnd <= slack
    && Math.abs((late.start_utc - early.start_utc) - (early.duration_s - late.duration_s)) <= slack;
}

interface PairEvaluation {
  readonly diagnostic: PairDiagnostic;
  readonly strict: boolean;
  readonly near: boolean;
  readonly overlap: boolean;
  readonly durationSort: number;
  readonly distanceSort: number;
  readonly distanceTested: boolean;
}

function evaluatePair(left: DedupCandidateSummary, right: DedupCandidateSummary): PairEvaluation {
  const [a, b] = orient(left, right);
  const duration = ratioDelta(a.duration_s, b.duration_s);
  if (duration.state === "invalid_input") throw new TypeError("invalid duration ratio input");
  const distance = a.distance_m === null || b.distance_m === null
    ? { state: "untested" as const, value: null }
    : ratioDelta(a.distance_m, b.distance_m);
  if (distance.state === "invalid_input") throw new TypeError("invalid distance ratio input");
  const contained = containment(a, b, DEFAULT_TIER3_THRESHOLDS.containmentSlackSeconds);
  const startDelta = Math.abs(a.start_utc - b.start_utc);
  const durationLimit = DEFAULT_TIER3_THRESHOLDS.durationPercent / 100;
  const distanceLimit = DEFAULT_TIER3_THRESHOLDS.distancePercent / 100;
  const within = (a: number, b: number, limit: number): boolean => a === 0 && b === 0
    || (a > 0 && b > 0 && Math.max(a, b) <= Math.min(a, b) * (1 + limit));
  const durationPass = duration.state === "value" && within(a.duration_s, b.duration_s, durationLimit);
  const distancePass = distance.state === "untested" || (distance.state === "value" && within(a.distance_m!, b.distance_m!, distanceLimit));
  const strict = a.sport_family === b.sport_family && !a.is_transition && !b.is_transition
    && (startDelta <= DEFAULT_TIER3_THRESHOLDS.startSeconds || contained)
    && durationPass && distancePass;
  const multiple = DEFAULT_TIER3_THRESHOLDS.nearMissMultiplier;
  const near = a.sport_family === b.sport_family && !a.is_transition && !b.is_transition
    && (startDelta <= DEFAULT_TIER3_THRESHOLDS.startSeconds * multiple || contained)
    && duration.state === "value" && within(a.duration_s, b.duration_s, durationLimit * multiple)
    && (distance.state === "untested" || (distance.state === "value" && within(a.distance_m!, b.distance_m!, distanceLimit * multiple)));
  const endA = a.start_utc + a.duration_s;
  const endB = b.start_utc + b.duration_s;
  const overlap = a.sport_family === b.sport_family
    && a.start_utc - 600 <= endB + 600
    && b.start_utc - 600 <= endA + 600;
  const diagnostic: PairDiagnostic = {
    member_a: a.member_id,
    member_b: b.member_id,
    candidate_a: a.candidate_id,
    candidate_b: b.candidate_id,
    serial_a: a.file_id_serial,
    serial_b: b.file_id_serial,
    start_delta_s: startDelta,
    duration_ratio: duration.state === "value" ? duration.value : null,
    duration_ratio_failed: duration.state === "one_zero",
    distance_ratio: distance.state === "value" ? distance.value : null,
    distance_ratio_state: distance.state,
    containment: contained,
    distance_untested: distance.state === "untested",
    reason: "",
  };
  return {
    diagnostic,
    strict,
    near,
    overlap,
    durationSort: duration.state === "value" ? duration.value : Number.POSITIVE_INFINITY,
    distanceSort: distance.state === "value" ? distance.value : 0,
    distanceTested: distance.state !== "untested",
  };
}

class DisjointSet {
  private readonly parent = new Map<string, string>();
  add(value: string): void { if (!this.parent.has(value)) this.parent.set(value, value); }
  find(value: string): string {
    const parent = this.parent.get(value);
    if (parent === undefined) throw new Error("unknown disjoint-set member");
    if (parent === value) return value;
    const root = this.find(parent);
    this.parent.set(value, root);
    return root;
  }
  union(left: string, right: string): boolean {
    const a = this.find(left), b = this.find(right);
    if (a === b) return false;
    if (a < b) this.parent.set(b, a); else this.parent.set(a, b);
    return true;
  }
  groups(): Map<string, string[]> {
    const groups = new Map<string, string[]>();
    for (const value of this.parent.keys()) {
      const root = this.find(value);
      const values = groups.get(root) ?? [];
      values.push(value);
      groups.set(root, values);
    }
    for (const values of groups.values()) values.sort(compareText);
    return groups;
  }
}

function confirmationOrder(left: DedupConfirmationRow, right: DedupConfirmationRow): number {
  return right.hlc_physical_ms - left.hlc_physical_ms
    || right.hlc_counter - left.hlc_counter
    || compareText(right.device_id, left.device_id)
    || compareText(right.id, left.id);
}

export interface DedupSessionPlan {
  readonly group: LogicalSessionGroup;
  readonly summaries: readonly DedupCandidateSummary[];
  readonly members: readonly string[];
  readonly edge_tiers: readonly ("tier2" | "tier3" | "confirmation")[];
}

export interface DedupWorkoutPlan {
  readonly session_group_ids: readonly string[];
  readonly members: readonly string[];
  readonly edge_tiers: readonly ("tier2" | "tier3" | "confirmation")[];
}

export interface DedupPlan {
  readonly sessions: readonly DedupSessionPlan[];
  readonly workouts: readonly DedupWorkoutPlan[];
  readonly threshold_near_misses: readonly PairDiagnostic[];
  readonly overlap_watchlist: readonly OverlapDiagnostic[];
  readonly confirm_queue: readonly PairDiagnostic[];
  readonly applied_confirmations: readonly AppliedConfirmationReport[];
  readonly effective_distinct_pairs: ReadonlySet<string>;
}

interface SelectedEdge {
  readonly a: DedupCandidateSummary;
  readonly b: DedupCandidateSummary;
  readonly tier: "tier2" | "tier3" | "confirmation";
  readonly diagnostic: PairDiagnostic;
}

function pairDiagnosticOrder(left: PairDiagnostic, right: PairDiagnostic): number {
  return compareText(left.member_a, right.member_a) || compareText(left.member_b, right.member_b)
    || compareText(left.candidate_a, right.candidate_a) || compareText(left.candidate_b, right.candidate_b);
}

export function planDedup(
  candidateValues: readonly Candidate[],
  summaryValues: readonly DedupCandidateSummary[],
  confirmations: readonly DedupConfirmationRow[],
): DedupPlan {
  const summaryByCandidate = new Map<string, DedupCandidateSummary>();
  const candidateById = new Map<string, Candidate>();
  for (const summary of summaryValues) {
    validateSummary(summary);
    const encoded = JSON.stringify(summary);
    const prior = summaryByCandidate.get(summary.candidate_id);
    if (prior && JSON.stringify(prior) !== encoded) throw new Error("dedup candidate summary conflict");
    summaryByCandidate.set(summary.candidate_id, summary);
  }
  for (const candidate of candidateValues) {
    const prior = candidateById.get(candidate.id);
    if (prior && JSON.stringify(prior) !== JSON.stringify(candidate)) throw new Error("candidate identity conflict");
    candidateById.set(candidate.id, candidate);
    if (!summaryByCandidate.has(candidate.id)) throw new Error("candidate summary missing");
  }
  if (candidateById.size !== summaryByCandidate.size) throw new Error("candidate presentation mismatch");
  const candidates = [...candidateById.values()].sort((a, b) => compareText(a.id, b.id));
  const summaries = candidates.map((candidate) => summaryByCandidate.get(candidate.id)!);
  const memberSet = new Set(summaries.map((summary) => summary.member_id));
  const histories = new Map<string, DedupConfirmationRow[]>();
  for (const row of confirmations) {
    const key = pairKey(row.member_a, row.member_b);
    const values = histories.get(key) ?? [];
    values.push(row);
    histories.set(key, values);
  }
  for (const values of histories.values()) values.sort(confirmationOrder);
  const effective = new Map<string, DedupConfirmationRow>();
  for (const [key, values] of histories) effective.set(key, values[0]!);
  const distinctPairs = new Set([...effective].filter(([, row]) => row.verdict === "distinct").map(([key]) => key));

  const selected: SelectedEdge[] = [];
  const queued: PairDiagnostic[] = [];
  const byMemberPair = new Map<string, { readonly left: DedupCandidateSummary; readonly right: DedupCandidateSummary; readonly eval: PairEvaluation }[]>();
  for (let i = 0; i < summaries.length; i += 1) for (let j = i + 1; j < summaries.length; j += 1) {
    const left = summaries[i]!, right = summaries[j]!;
    if (left.member_id === right.member_id) continue;
    const [a, b] = orient(left, right);
    const values = byMemberPair.get(pairKey(a.member_id, b.member_id)) ?? [];
    values.push({ left: a, right: b, eval: evaluatePair(a, b) });
    byMemberPair.set(pairKey(a.member_id, b.member_id), values);
  }
  for (const [key, pairs] of [...byMemberPair].sort(([a], [b]) => compareText(a, b))) {
    const tier2 = pairs.filter(({ left, right }) => left.source_kind === "fit" && right.source_kind === "fit"
      && left.file_id_manufacturer !== null && right.file_id_manufacturer !== null
      && left.file_id_serial !== null && right.file_id_serial !== null
      && left.file_id_time_created_utc !== null && right.file_id_time_created_utc !== null
      && left.file_id_manufacturer === right.file_id_manufacturer
      && left.file_id_serial === right.file_id_serial
      && left.file_id_time_created_utc === right.file_id_time_created_utc
      && left.source_session_seq === right.source_session_seq
      && left.sport_family === right.sport_family)
      .sort((a, b) => a.left.source_session_seq - b.left.source_session_seq
        || compareText(a.left.candidate_id, b.left.candidate_id) || compareText(a.right.candidate_id, b.right.candidate_id));
    const used = new Set<string>();
    for (const pair of tier2) {
      if (used.has(pair.left.candidate_id) || used.has(pair.right.candidate_id)) continue;
      used.add(pair.left.candidate_id); used.add(pair.right.candidate_id);
      selected.push({ a: pair.left, b: pair.right, tier: "tier2", diagnostic: pair.eval.diagnostic });
    }
    const tier3 = pairs.filter((pair) => !used.has(pair.left.candidate_id) && !used.has(pair.right.candidate_id)
      && !tier2.includes(pair) && pair.eval.strict)
      .sort((a, b) => a.eval.diagnostic.start_delta_s - b.eval.diagnostic.start_delta_s
        || a.eval.durationSort - b.eval.durationSort
        || Number(b.eval.distanceTested) - Number(a.eval.distanceTested)
        || a.eval.distanceSort - b.eval.distanceSort
        || compareText(a.left.candidate_id, b.left.candidate_id)
        || compareText(a.right.candidate_id, b.right.candidate_id));
    const accepted: typeof tier3 = [];
    for (const pair of tier3) {
      if (used.has(pair.left.candidate_id) || used.has(pair.right.candidate_id)) continue;
      used.add(pair.left.candidate_id); used.add(pair.right.candidate_id); accepted.push(pair);
    }
    const effectiveRow = effective.get(key);
    const differing = accepted.filter((pair) => pair.left.file_id_serial !== pair.right.file_id_serial);
    for (const pair of accepted) {
      if (pair.left.file_id_serial === pair.right.file_id_serial) {
        selected.push({ a: pair.left, b: pair.right, tier: "tier3", diagnostic: pair.eval.diagnostic });
      } else if (effectiveRow?.verdict === "merge") {
        selected.push({ a: pair.left, b: pair.right, tier: "confirmation", diagnostic: pair.eval.diagnostic });
      }
    }
    if (differing.length > 0 && effectiveRow?.verdict !== "merge") {
      const pair = differing.sort((a, b) => compareText(a.left.candidate_id, b.left.candidate_id)
        || compareText(a.right.candidate_id, b.right.candidate_id))[0]!;
      queued.push({ ...pair.eval.diagnostic, reason: "tier3_serial_confirmation_required" });
    }
  }
  const tierOrder = { tier2: 0, tier3: 1, confirmation: 2 } as const;
  selected.sort((left, right) => compareText(left.a.member_id, right.a.member_id)
    || compareText(left.b.member_id, right.b.member_id)
    || compareText(left.a.candidate_id, right.a.candidate_id)
    || compareText(left.b.candidate_id, right.b.candidate_id)
    || tierOrder[left.tier] - tierOrder[right.tier]);

  const dsu = new DisjointSet();
  for (const candidate of candidates) dsu.add(candidate.id);
  const memberByCandidate = new Map(summaries.map((summary) => [summary.candidate_id, summary.member_id]));
  const edgeTierByRootCandidate = new Map<string, Set<"tier2" | "tier3" | "confirmation">>();
  const membersForRoot = (root: string): Set<string> => new Set((dsu.groups().get(root) ?? []).map((id) => memberByCandidate.get(id)!));
  const blocked = (leftRoot: string, rightRoot: string): boolean => {
    const left = membersForRoot(leftRoot), right = membersForRoot(rightRoot);
    for (const a of left) for (const b of right) if (a !== b && distinctPairs.has(pairKey(a, b))) return true;
    return false;
  };
  for (const edge of selected) {
    const leftRoot = dsu.find(edge.a.candidate_id), rightRoot = dsu.find(edge.b.candidate_id);
    if (leftRoot === rightRoot || blocked(leftRoot, rightRoot)) continue;
    const inherited = new Set([...(edgeTierByRootCandidate.get(leftRoot) ?? []), ...(edgeTierByRootCandidate.get(rightRoot) ?? []), edge.tier]);
    dsu.union(leftRoot, rightRoot);
    edgeTierByRootCandidate.delete(leftRoot); edgeTierByRootCandidate.delete(rightRoot);
    edgeTierByRootCandidate.set(dsu.find(leftRoot), inherited);
  }
  const candidateGroups = dsu.groups();
  const sessionPlans: DedupSessionPlan[] = [];
  for (const ids of candidateGroups.values()) {
    const groupCandidates = ids.map((id) => candidateById.get(id)!);
    const groupSummaries = ids.map((id) => summaryByCandidate.get(id)!);
    const groupId = ids[0]!;
    const fitSerialByCandidateId: Record<string, number | null> = {};
    for (const summary of groupSummaries) if (summary.source_kind === "fit") fitSerialByCandidateId[summary.candidate_id] = summary.file_id_serial;
    const root = dsu.find(groupId);
    const tiers = [...(edgeTierByRootCandidate.get(root) ?? [])].sort((a, b) => tierOrder[a] - tierOrder[b]);
    const members = [...new Set(groupSummaries.map((summary) => summary.member_id))].sort(compareText);
    sessionPlans.push({
      group: { id: groupId, candidates: groupCandidates, fitSerialByCandidateId },
      summaries: groupSummaries,
      members,
      edge_tiers: tiers,
    });
  }
  sessionPlans.sort((a, b) => {
    const aStart = Math.min(...a.summaries.map((summary) => summary.start_utc));
    const bStart = Math.min(...b.summaries.map((summary) => summary.start_utc));
    return aStart - bStart || compareText(a.group.id, b.group.id);
  });
  const workoutDsu = new DisjointSet();
  for (const session of sessionPlans) workoutDsu.add(session.group.id);
  const sessionByGroupId = new Map(sessionPlans.map((session) => [session.group.id, session]));
  const sessionsByMember = new Map<string, string[]>();
  for (const session of sessionPlans) for (const member of session.members) {
    const values = sessionsByMember.get(member) ?? [];
    values.push(session.group.id);
    sessionsByMember.set(member, values);
  }
  const workoutEdges = new Map<string, readonly [string, string]>();
  for (const sessionIds of sessionsByMember.values()) for (let i = 0; i < sessionIds.length; i += 1) {
    for (let j = i + 1; j < sessionIds.length; j += 1) {
      const left = sessionIds[i]!, right = sessionIds[j]!;
      const edge: readonly [string, string] = left < right ? [left, right] : [right, left];
      workoutEdges.set(pairKey(edge[0], edge[1]), edge);
    }
  }
  const workoutMembersForRoot = (root: string): Set<string> => new Set(
    (workoutDsu.groups().get(root) ?? []).flatMap((id) => sessionByGroupId.get(id)!.members),
  );
  const workoutBlocked = (leftRoot: string, rightRoot: string): boolean => {
    const left = workoutMembersForRoot(leftRoot), right = workoutMembersForRoot(rightRoot);
    for (const a of left) for (const b of right) if (a !== b && distinctPairs.has(pairKey(a, b))) return true;
    return false;
  };
  for (const [left, right] of [...workoutEdges.values()].sort((a, b) => compareText(a[0], b[0]) || compareText(a[1], b[1]))) {
    const leftRoot = workoutDsu.find(left), rightRoot = workoutDsu.find(right);
    if (leftRoot !== rightRoot && !workoutBlocked(leftRoot, rightRoot)) workoutDsu.union(leftRoot, rightRoot);
  }
  const workouts: DedupWorkoutPlan[] = [...workoutDsu.groups().values()].map((sessionIds) => {
    const sessions = sessionIds.map((id) => sessionPlans.find((entry) => entry.group.id === id)!);
    return {
      session_group_ids: sessionIds,
      members: [...new Set(sessions.flatMap((session) => session.members))].sort(compareText),
      edge_tiers: [...new Set(sessions.flatMap((session) => session.edge_tiers))].sort((a, b) => tierOrder[a] - tierOrder[b]),
    };
  }).sort((a, b) => compareText(a.members[0]!, b.members[0]!));

  const sameComponent = (a: string, b: string): boolean => dsu.find(a) === dsu.find(b);
  const nearMisses: PairDiagnostic[] = [];
  const overlaps: OverlapDiagnostic[] = [];
  for (const pairs of byMemberPair.values()) for (const pair of pairs) {
    if (sameComponent(pair.left.candidate_id, pair.right.candidate_id)) continue;
    if (pair.eval.near) nearMisses.push({ ...pair.eval.diagnostic, reason: "tier3_threshold_near_miss" });
    if (pair.eval.overlap) {
      overlaps.push({
        ...pair.eval.diagnostic,
        reason: "expanded_overlap_unmerged",
        expanded_a: { start_utc: pair.left.start_utc - 600, end_utc: pair.left.start_utc + pair.left.duration_s + 600 },
        expanded_b: { start_utc: pair.right.start_utc - 600, end_utc: pair.right.start_utc + pair.right.duration_s + 600 },
      });
    }
  }
  const selectedConfirmationPairs = new Set(selected.filter((edge) => edge.tier === "confirmation").map((edge) => pairKey(edge.a.member_id, edge.b.member_id)));
  const applied: AppliedConfirmationReport[] = [];
  for (const [key, rows] of histories) for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    let result: AppliedConfirmationReport["result"], reason: string;
    if (!memberSet.has(row.member_a) || !memberSet.has(row.member_b)) {
      result = "orphaned"; reason = "confirmation_member_missing";
    } else if (index > 0) {
      result = "superseded"; reason = "superseded_confirmation";
    } else if (row.verdict === "distinct") {
      result = "cannot_link_applied"; reason = "effective_distinct_confirmation";
    } else if (selectedConfirmationPairs.has(key)) {
      result = "edge_authorized"; reason = "effective_merge_confirmation";
    } else {
      result = "no_matching_candidate_edge"; reason = "effective_merge_no_matching_candidate_edge";
    }
    applied.push({ id: row.id, member_a: row.member_a, member_b: row.member_b, verdict: row.verdict,
      hlc_physical_ms: row.hlc_physical_ms, hlc_counter: row.hlc_counter, device_id: row.device_id, result, reason });
  }
  applied.sort((a, b) => compareText(a.member_a, b.member_a) || compareText(a.member_b, b.member_b)
    || b.hlc_physical_ms - a.hlc_physical_ms || b.hlc_counter - a.hlc_counter
    || compareText(b.device_id, a.device_id) || compareText(b.id, a.id));
  return {
    sessions: sessionPlans,
    workouts,
    threshold_near_misses: nearMisses.sort(pairDiagnosticOrder),
    overlap_watchlist: overlaps.sort(pairDiagnosticOrder),
    confirm_queue: queued.sort(pairDiagnosticOrder),
    applied_confirmations: applied,
    effective_distinct_pairs: distinctPairs,
  };
}

export function dedupPairKey(left: string, right: string): string { return pairKey(left, right); }
