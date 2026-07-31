import { dedupPairKey, type DedupPlan, type DedupSessionPlan, type DedupWorkoutPlan } from "./dedup.js";

export const DEFAULT_TRANSITION_WINDOW_S = 900 as const;

export interface BrickReport {
  readonly members: readonly [string, string];
  readonly families: readonly [string, string];
  readonly gap_s: number;
  readonly effective_transition_window_s: number;
}

export interface SportSettingInput {
  readonly sport: string;
  readonly session_cluster_conventions_json: string | null;
}

export interface BrickWorkoutPlan {
  readonly session_group_ids: readonly string[];
  readonly members: readonly string[];
  readonly edge_tiers: readonly ("tier2" | "tier3" | "confirmation" | "brick")[];
}

export interface BrickPlanResult {
  readonly workouts: readonly BrickWorkoutPlan[];
  readonly brick_groups: readonly BrickReport[];
}

function compareText(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

function transitionWindows(rows: readonly SportSettingInput[]): Map<string, number> {
  const windows = new Map<string, number>();
  for (const row of rows) {
    if (typeof row.sport !== "string" || row.sport.length === 0 || windows.has(row.sport)) throw new TypeError("invalid sport setting");
    if (row.session_cluster_conventions_json === null) {
      windows.set(row.sport, DEFAULT_TRANSITION_WINDOW_S);
      continue;
    }
    let parsed: unknown;
    try { parsed = JSON.parse(row.session_cluster_conventions_json); } catch { throw new TypeError("invalid session cluster conventions"); }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new TypeError("invalid session cluster conventions");
    const value = (parsed as Record<string, unknown>).transition_window_s;
    if (value === undefined) windows.set(row.sport, DEFAULT_TRANSITION_WINDOW_S);
    else if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError("invalid transition window");
    else windows.set(row.sport, value as number);
  }
  return windows;
}

interface SessionInfo {
  readonly plan: DedupSessionPlan;
  readonly start: number;
  readonly duration: number;
  readonly family: string;
  readonly transition: boolean;
  readonly fileMembers: readonly string[];
  readonly firstCandidate: string;
}

function sessionInfo(plan: DedupSessionPlan): SessionInfo {
  const ordered = [...plan.summaries].sort((a, b) => a.start_utc - b.start_utc || compareText(a.candidate_id, b.candidate_id));
  const first = ordered[0]!;
  const fileMembers = [...new Set(plan.summaries
    .filter((summary) => summary.source_kind !== "platform_api")
    .map((summary) => summary.member_id))].sort(compareText);
  return { plan, start: first.start_utc, duration: first.duration_s, family: first.sport_family,
    transition: first.is_transition, fileMembers, firstCandidate: first.candidate_id };
}

class Sets {
  private readonly parent = new Map<string, string>();
  add(value: string): void { this.parent.set(value, value); }
  find(value: string): string {
    const parent = this.parent.get(value);
    if (parent === undefined) throw new Error("unknown workout component");
    if (parent === value) return value;
    const root = this.find(parent); this.parent.set(value, root); return root;
  }
  union(a: string, b: string): boolean {
    const left = this.find(a), right = this.find(b);
    if (left === right) return false;
    if (left < right) this.parent.set(right, left); else this.parent.set(left, right);
    return true;
  }
  groups(): Map<string, string[]> {
    const result = new Map<string, string[]>();
    for (const value of this.parent.keys()) {
      const root = this.find(value), values = result.get(root) ?? [];
      values.push(value); result.set(root, values);
    }
    for (const values of result.values()) values.sort(compareText);
    return result;
  }
}

export type BrickTopologyInput = Pick<DedupPlan, "sessions" | "workouts" | "effective_distinct_pairs">;

/** Lightweight cache/topology adapter used by incremental ingest. */
export function planBrickAdjacencyFromTopology(dedup: BrickTopologyInput, settings: readonly SportSettingInput[]): BrickPlanResult {
  const windows = transitionWindows(settings);
  const sessions = dedup.sessions.map(sessionInfo).sort((a, b) => a.start - b.start || compareText(a.firstCandidate, b.firstCandidate));
  const workoutBySession = new Map<string, DedupWorkoutPlan>();
  for (const workout of dedup.workouts) for (const id of workout.session_group_ids) workoutBySession.set(id, workout);
  const keyForWorkout = (workout: DedupWorkoutPlan): string => workout.session_group_ids[0]!;
  const sets = new Sets();
  for (const workout of dedup.workouts) sets.add(keyForWorkout(workout));
  const workoutByKey = new Map(dedup.workouts.map((workout) => [keyForWorkout(workout), workout]));
  const reports: BrickReport[] = [];
  const membersForRoot = (root: string): string[] => [...new Set((sets.groups().get(root) ?? [])
    .flatMap((key) => workoutByKey.get(key)!.members))].sort(compareText);
  const blocked = (left: string, right: string): boolean => {
    for (const a of membersForRoot(left)) for (const b of membersForRoot(right)) {
      if (a !== b && dedup.effective_distinct_pairs.has(dedupPairKey(a, b))) return true;
    }
    return false;
  };
  for (let index = 0; index + 1 < sessions.length; index += 1) {
    const earlier = sessions[index]!, later = sessions[index + 1]!;
    const gap = later.start - (earlier.start + earlier.duration);
    const window = windows.get(earlier.family) ?? DEFAULT_TRANSITION_WINDOW_S;
    const disjoint = earlier.fileMembers.every((member) => !later.fileMembers.includes(member));
    if (earlier.transition || later.transition || earlier.family === later.family
        || earlier.fileMembers.length === 0 || later.fileMembers.length === 0 || !disjoint
        || gap < 0 || gap > window) continue;
    const earlierWorkout = workoutBySession.get(earlier.plan.group.id)!;
    const laterWorkout = workoutBySession.get(later.plan.group.id)!;
    const leftRoot = sets.find(keyForWorkout(earlierWorkout)), rightRoot = sets.find(keyForWorkout(laterWorkout));
    if (leftRoot === rightRoot || blocked(leftRoot, rightRoot)) continue;
    sets.union(leftRoot, rightRoot);
    reports.push({ members: [earlier.fileMembers[0]!, later.fileMembers[0]!], families: [earlier.family, later.family],
      gap_s: gap, effective_transition_window_s: window });
  }
  const workouts = [...sets.groups().values()].map((keys) => {
    const merged = keys.map((key) => workoutByKey.get(key)!);
    const tiers = [...new Set(merged.flatMap((workout) => workout.edge_tiers))] as ("tier2" | "tier3" | "confirmation" | "brick")[];
    if (keys.length > 1) tiers.push("brick");
    const order = { tier2: 0, tier3: 1, confirmation: 2, brick: 3 } as const;
    return {
      session_group_ids: [...new Set(merged.flatMap((workout) => workout.session_group_ids))].sort(compareText),
      members: [...new Set(merged.flatMap((workout) => workout.members))].sort(compareText),
      edge_tiers: [...new Set(tiers)].sort((a, b) => order[a] - order[b]),
    };
  }).sort((a, b) => compareText(a.members[0]!, b.members[0]!));
  reports.sort((a, b) => compareText(a.members[0], b.members[0]) || compareText(a.members[1], b.members[1]));
  return { workouts, brick_groups: reports };
}

export function planBrickAdjacency(dedup: DedupPlan, settings: readonly SportSettingInput[]): BrickPlanResult {
  return planBrickAdjacencyFromTopology(dedup, settings);
}
