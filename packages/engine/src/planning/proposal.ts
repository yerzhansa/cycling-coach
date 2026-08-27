import { canonicalJson } from "@enduragent/kernel/archive";
import {
  addCivilDays,
  encodePlanAdaptationWorkoutSnapshot,
  planAdaptationWorkoutSnapshot,
  planWeekIndex,
  type PlanProposalPremiseRecord,
  type PlanProposalRecord,
  type PlanProposalRepository,
  type PlanRecord,
  type PlanWorkoutRecord,
} from "@enduragent/kernel/planning";

export interface PlanProposalWorkoutValue {
  readonly dateKey: number;
  readonly sport: string;
  readonly name: string;
  readonly durationS: number | null;
  readonly structureJson: string;
}

export interface PlanProposalWorkoutChange {
  readonly workoutId: string;
  readonly before: PlanProposalWorkoutValue | null;
  readonly after: PlanProposalWorkoutValue;
}

export interface PlanProposalMutation {
  readonly schemaVersion: 1;
  readonly changes: readonly PlanProposalWorkoutChange[];
  readonly weekLoad: { readonly before: number; readonly after: number } | null;
}

export interface PlanProposalBaseSnapshot {
  readonly schemaVersion: 1;
  readonly planUpdatedAtMs: number;
  readonly planHlcPhysicalMs: number;
  readonly planHlcCounter: number;
  readonly workouts: readonly ({ readonly id: string } & PlanProposalWorkoutValue)[];
}

export interface PlanProposalDiffLine {
  readonly field: "duration" | "workout" | "date" | "week-load";
  readonly label: string;
  readonly before: string;
  readonly after: string;
}

export interface ValidatedPlanProposal {
  readonly proposal: PlanProposalRecord;
  readonly premises: readonly PlanProposalPremiseRecord[];
  readonly mutation: PlanProposalMutation;
  readonly base: PlanProposalBaseSnapshot;
  readonly changes: readonly {
    readonly current: PlanWorkoutRecord | null;
    readonly next: PlanWorkoutRecord;
  }[];
  readonly diff: readonly PlanProposalDiffLine[];
}

export type PlanProposalLoadCalculator = (workouts: readonly PlanWorkoutRecord[]) => number;

export interface PlanProposalPremiseReader {
  read(input: { readonly sourceType: string; readonly sourceId: string }): Promise<string | null>;
}

export class PlanProposalError extends Error {
  readonly code:
    | "invalid-mutation"
    | "invalid-base"
    | "missing-capability"
    | "stale-base"
    | "unsafe-workout"
    | "missing-premise";

  constructor(code: PlanProposalError["code"]) {
    super(`plan proposal failed: ${code}`);
    this.name = "PlanProposalError";
    this.code = code;
  }
}

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validJson(value: string): boolean {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

function hasStructuredWorkoutContent(value: string): boolean {
  try {
    const parsed = JSON.parse(value) as unknown;
    return !object(parsed) || Object.keys(parsed).length > 0;
  } catch {
    return true;
  }
}

function validDateKey(value: unknown): value is number {
  if (!Number.isSafeInteger(value)) return false;
  try {
    addCivilDays(value as number, 0);
    return true;
  } catch {
    return false;
  }
}

function workoutValue(
  value: unknown,
  errorCode: "invalid-mutation" | "invalid-base" = "invalid-mutation",
): PlanProposalWorkoutValue {
  if (
    !object(value) ||
    !exactKeys(value, ["dateKey", "durationS", "name", "sport", "structureJson"])
  ) {
    throw new PlanProposalError(errorCode);
  }
  if (
    !validDateKey(value.dateKey) ||
    typeof value.sport !== "string" ||
    value.sport.length === 0 ||
    typeof value.name !== "string" ||
    value.name.length === 0 ||
    (value.durationS !== null &&
      (!Number.isSafeInteger(value.durationS) || Number(value.durationS) <= 0)) ||
    typeof value.structureJson !== "string" ||
    !validJson(value.structureJson)
  ) {
    throw new PlanProposalError(errorCode);
  }
  return Object.freeze({
    dateKey: Number(value.dateKey),
    sport: value.sport,
    name: value.name,
    durationS: value.durationS === null ? null : Number(value.durationS),
    structureJson: value.structureJson,
  });
}

export function parsePlanProposalMutation(value: string): PlanProposalMutation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new PlanProposalError("invalid-mutation");
  }
  if (!object(parsed) || !exactKeys(parsed, ["changes", "schemaVersion", "weekLoad"])) {
    throw new PlanProposalError("invalid-mutation");
  }
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.changes) || parsed.changes.length !== 1) {
    throw new PlanProposalError("invalid-mutation");
  }
  const ids = new Set<string>();
  const changes = parsed.changes.map((value): PlanProposalWorkoutChange => {
    if (
      !object(value) ||
      !exactKeys(value, ["after", "before", "workoutId"]) ||
      !ULID.test(String(value.workoutId))
    ) {
      throw new PlanProposalError("invalid-mutation");
    }
    const workoutId = String(value.workoutId);
    if (ids.has(workoutId)) throw new PlanProposalError("invalid-mutation");
    ids.add(workoutId);
    const before = value.before === null ? null : workoutValue(value.before);
    const after = workoutValue(value.after);
    if (before !== null && canonicalJson(before) === canonicalJson(after))
      throw new PlanProposalError("invalid-mutation");
    return Object.freeze({ workoutId, before, after });
  });
  let weekLoad: PlanProposalMutation["weekLoad"] = null;
  if (parsed.weekLoad !== null) {
    if (
      !object(parsed.weekLoad) ||
      !exactKeys(parsed.weekLoad, ["after", "before"]) ||
      !Number.isFinite(parsed.weekLoad.before) ||
      !Number.isFinite(parsed.weekLoad.after) ||
      Number(parsed.weekLoad.before) < 0 ||
      Number(parsed.weekLoad.after) < 0 ||
      Number(parsed.weekLoad.before) === Number(parsed.weekLoad.after)
    ) {
      throw new PlanProposalError("invalid-mutation");
    }
    weekLoad = Object.freeze({
      before: Number(parsed.weekLoad.before),
      after: Number(parsed.weekLoad.after),
    });
  }
  return Object.freeze({ schemaVersion: 1, changes, weekLoad });
}

function parseBase(value: string): PlanProposalBaseSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new PlanProposalError("invalid-base");
  }
  if (
    !object(parsed) ||
    !exactKeys(parsed, [
      "planHlcCounter",
      "planHlcPhysicalMs",
      "planUpdatedAtMs",
      "schemaVersion",
      "workouts",
    ]) ||
    parsed.schemaVersion !== 1 ||
    !Number.isSafeInteger(parsed.planUpdatedAtMs) ||
    Number(parsed.planUpdatedAtMs) < 0 ||
    !Number.isSafeInteger(parsed.planHlcPhysicalMs) ||
    Number(parsed.planHlcPhysicalMs) < 0 ||
    !Number.isSafeInteger(parsed.planHlcCounter) ||
    Number(parsed.planHlcCounter) < 0 ||
    !Array.isArray(parsed.workouts) ||
    parsed.workouts.length === 0
  ) {
    throw new PlanProposalError("invalid-base");
  }
  const workouts = parsed.workouts.map((value) => {
    if (!object(value) || !ULID.test(String(value.id))) throw new PlanProposalError("invalid-base");
    const copy = { ...value };
    delete copy.id;
    return Object.freeze({ id: String(value.id), ...workoutValue(copy, "invalid-base") });
  });
  return Object.freeze({
    schemaVersion: 1,
    planUpdatedAtMs: Number(parsed.planUpdatedAtMs),
    planHlcPhysicalMs: Number(parsed.planHlcPhysicalMs),
    planHlcCounter: Number(parsed.planHlcCounter),
    workouts,
  });
}

function valueOf(workout: PlanWorkoutRecord): PlanProposalWorkoutValue {
  return Object.freeze({
    dateKey: workout.dateKey,
    sport: workout.sport,
    name: workout.name,
    durationS: workout.durationS,
    structureJson: workout.structureJson,
  });
}

export function capturePlanProposalBase(
  plan: PlanRecord,
  workouts: readonly PlanWorkoutRecord[],
): PlanProposalBaseSnapshot {
  return Object.freeze({
    schemaVersion: 1,
    planUpdatedAtMs: plan.updatedAtMs,
    planHlcPhysicalMs: plan.hlcPhysicalMs,
    planHlcCounter: plan.hlcCounter,
    workouts: workouts.map((workout) => Object.freeze({ id: workout.id, ...valueOf(workout) })),
  });
}

export function encodePlanProposalBase(value: PlanProposalBaseSnapshot): string {
  return canonicalJson(value);
}

export function encodePlanProposalMutation(value: PlanProposalMutation): string {
  return canonicalJson(value);
}

function duration(value: number | null): string {
  if (value === null) return "—";
  const hours = Math.floor(value / 3_600);
  const minutes = Math.floor((value % 3_600) / 60);
  const seconds = value % 60;
  const minutePrecision =
    hours > 0
      ? `${hours}:${String(minutes).padStart(2, "0")}`
      : `0:${String(minutes).padStart(2, "0")}`;
  return seconds === 0 ? minutePrecision : `${minutePrecision}:${String(seconds).padStart(2, "0")}`;
}

export function projectPlanProposalDiff(
  mutation: PlanProposalMutation,
): readonly PlanProposalDiffLine[] {
  const lines: PlanProposalDiffLine[] = [];
  for (const change of mutation.changes) {
    if (change.before === null) {
      lines.push(
        {
          field: "date",
          label: "Date",
          before: "None",
          after: String(change.after.dateKey),
        },
        {
          field: "workout",
          label: "Workout",
          before: "None",
          after: change.after.name,
        },
      );
      continue;
    }
    if (change.before.durationS !== change.after.durationS) {
      lines.push({
        field: "duration",
        label: "Duration",
        before: duration(change.before.durationS),
        after: duration(change.after.durationS),
      });
    }
    if (change.before.name !== change.after.name) {
      lines.push({
        field: "workout",
        label: "Workout",
        before: change.before.name,
        after: change.after.name,
      });
    }
    if (change.before.dateKey !== change.after.dateKey) {
      lines.push({
        field: "date",
        label: "Date",
        before: String(change.before.dateKey),
        after: String(change.after.dateKey),
      });
    }
  }
  if (mutation.weekLoad !== null) {
    lines.push({
      field: "week-load",
      label: "Week load",
      before: String(mutation.weekLoad.before),
      after: String(mutation.weekLoad.after),
    });
  }
  return Object.freeze(lines.map((line) => Object.freeze(line)));
}

export function validatePlanProposal(input: {
  readonly proposal: PlanProposalRecord;
  readonly premises: readonly PlanProposalPremiseRecord[];
  readonly plan: PlanRecord;
  readonly workouts: readonly PlanWorkoutRecord[];
  readonly todayDateKey: number;
  readonly calculateWeekLoad?: PlanProposalLoadCalculator;
}): ValidatedPlanProposal {
  if (input.premises.length === 0) throw new PlanProposalError("missing-premise");
  if (
    input.proposal.status !== "proposed" ||
    input.proposal.planId !== input.plan.id ||
    input.plan.status !== "active"
  ) {
    throw new PlanProposalError("unsafe-workout");
  }
  const mutation = parsePlanProposalMutation(input.proposal.mutationJson);
  const base = parseBase(input.proposal.baseSnapshotJson);
  if (
    base.planUpdatedAtMs !== input.plan.updatedAtMs ||
    base.planHlcPhysicalMs !== input.plan.hlcPhysicalMs ||
    base.planHlcCounter !== input.plan.hlcCounter
  ) {
    throw new PlanProposalError("stale-base");
  }
  const baseById = new Map(base.workouts.map((workout) => [workout.id, workout]));
  const currentById = new Map(input.workouts.map((workout) => [workout.id, workout]));
  const changes = mutation.changes.map((change) => {
    const current = currentById.get(change.workoutId);
    const captured = baseById.get(change.workoutId);
    if (change.before === null) {
      if (
        current !== undefined ||
        captured !== undefined ||
        change.after.dateKey <= input.todayDateKey ||
        planWeekIndex(input.plan, change.after.dateKey).kind !== "inside" ||
        input.workouts.some((workout) => workout.dateKey === change.after.dateKey)
      ) {
        throw new PlanProposalError("stale-base");
      }
      return Object.freeze({
        current: null,
        next: Object.freeze({
          id: change.workoutId,
          planId: input.plan.id,
          ...change.after,
          origin: "coach" as const,
          deviceId: input.plan.deviceId,
          hlcPhysicalMs: input.plan.hlcPhysicalMs,
          hlcCounter: input.plan.hlcCounter,
        }),
      });
    }
    if (current === undefined || captured === undefined) {
      throw new PlanProposalError("stale-base");
    }
    const { id: _capturedId, ...capturedValue } = captured;
    if (
      canonicalJson(valueOf(current)) !== canonicalJson(change.before) ||
      canonicalJson(valueOf(current)) !== canonicalJson(capturedValue)
    )
      throw new PlanProposalError("stale-base");
    if (
      current.origin !== "coach" ||
      current.dateKey <= input.todayDateKey ||
      change.after.dateKey <= input.todayDateKey ||
      planWeekIndex(input.plan, change.after.dateKey).kind !== "inside" ||
      change.after.sport !== current.sport ||
      change.after.structureJson !== current.structureJson ||
      ((change.after.name !== current.name || change.after.durationS !== current.durationS) &&
        hasStructuredWorkoutContent(current.structureJson))
    ) {
      throw new PlanProposalError("unsafe-workout");
    }
    return Object.freeze({
      current,
      next: Object.freeze({ ...current, ...change.after }),
    });
  });
  if (mutation.weekLoad !== null) {
    if (input.calculateWeekLoad === undefined) throw new PlanProposalError("missing-capability");
    const nextById = new Map(changes.map(({ next }) => [next.id, next]));
    const nextWorkouts = [
      ...input.workouts.map((workout) => nextById.get(workout.id) ?? workout),
      ...changes.flatMap(({ current, next }) => (current === null ? [next] : [])),
    ];
    let before: number;
    let after: number;
    try {
      before = input.calculateWeekLoad(input.workouts);
      after = input.calculateWeekLoad(nextWorkouts);
    } catch (error) {
      if (error instanceof PlanProposalError) throw error;
      throw new PlanProposalError("missing-capability");
    }
    if (
      !Number.isFinite(before) ||
      !Number.isFinite(after) ||
      before < 0 ||
      after < 0 ||
      before !== mutation.weekLoad.before ||
      after !== mutation.weekLoad.after
    ) {
      throw new PlanProposalError("invalid-mutation");
    }
  }
  return Object.freeze({
    proposal: input.proposal,
    premises: input.premises,
    mutation,
    base,
    changes,
    diff: projectPlanProposalDiff(mutation),
  });
}

export async function revalidatePlanProposalPremises(
  premises: readonly PlanProposalPremiseRecord[],
  reader: PlanProposalPremiseReader,
): Promise<void> {
  if (premises.length === 0) throw new PlanProposalError("missing-premise");
  for (const premise of premises) {
    const current = await reader.read({
      sourceType: premise.sourceType,
      sourceId: premise.sourceId,
    });
    if (current === null) throw new PlanProposalError("stale-base");
    let captured: unknown;
    let currentValue: unknown;
    try {
      captured = JSON.parse(premise.snapshotJson) as unknown;
      currentValue = JSON.parse(current) as unknown;
    } catch {
      throw new PlanProposalError("stale-base");
    }
    if (canonicalJson(captured) !== canonicalJson(currentValue)) {
      throw new PlanProposalError("stale-base");
    }
  }
}

export async function applyValidatedPlanProposal(
  validated: ValidatedPlanProposal,
  input: {
    readonly repository: PlanProposalRepository;
    readonly plan: PlanRecord;
    readonly resolvedAtMs: number;
    readonly deviceId: string;
    readonly hlcPhysicalMs: number;
    readonly hlcCounter: number;
    readonly mirrorJob: {
      readonly id: string;
      readonly windowStartDateKey: number;
      readonly windowEndDateKey: number;
      readonly createdAtMs: number;
    };
    readonly ledgerId: string;
  },
): Promise<PlanProposalRecord> {
  const workouts = validated.changes.map(({ next }) =>
    Object.freeze({
      ...next,
      deviceId: input.deviceId,
      hlcPhysicalMs: input.hlcPhysicalMs,
      hlcCounter: input.hlcCounter,
    }),
  );
  const change = validated.changes[0];
  if (change === undefined) throw new PlanProposalError("invalid-mutation");
  return input.repository.apply({
    id: validated.proposal.id,
    expectedPlanUpdatedAtMs: validated.base.planUpdatedAtMs,
    expectedPlanHlcPhysicalMs: validated.base.planHlcPhysicalMs,
    expectedPlanHlcCounter: validated.base.planHlcCounter,
    expectedWorkouts: validated.changes.flatMap(({ current }) =>
      current === null ? [] : [current],
    ),
    mirrorJob: input.mirrorJob,
    ledger: {
      id: input.ledgerId,
      planId: input.plan.id,
      targetWorkoutId: change.next.id,
      operation: change.current === null ? "add" : "update",
      kind: "proposal-applied",
      sourceId: validated.proposal.id,
      reversalOfId: null,
      label: validated.proposal.title,
      beforeJson:
        change.current === null
          ? null
          : encodePlanAdaptationWorkoutSnapshot(planAdaptationWorkoutSnapshot(change.current)),
      afterJson: encodePlanAdaptationWorkoutSnapshot(planAdaptationWorkoutSnapshot(workouts[0]!)),
      weekLoadBefore: validated.mutation.weekLoad?.before ?? null,
      weekLoadAfter: validated.mutation.weekLoad?.after ?? null,
      occurredAtMs: input.resolvedAtMs,
      deviceId: input.deviceId,
      hlcPhysicalMs: input.hlcPhysicalMs,
      hlcCounter: input.hlcCounter,
    },
    plan: Object.freeze({
      ...input.plan,
      updatedAtMs: input.resolvedAtMs,
      deviceId: input.deviceId,
      hlcPhysicalMs: input.hlcPhysicalMs,
      hlcCounter: input.hlcCounter,
    }),
    workouts,
    resolvedAtMs: input.resolvedAtMs,
    deviceId: input.deviceId,
    hlcPhysicalMs: input.hlcPhysicalMs,
    hlcCounter: input.hlcCounter,
  });
}
