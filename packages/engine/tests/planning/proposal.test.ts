import { describe, expect, it, vi } from "vitest";
import type {
  PlanProposalPremiseRecord,
  PlanProposalRecord,
  PlanProposalRepository,
  PlanRecord,
  PlanWorkoutRecord,
} from "@enduragent/kernel/planning";
import {
  applyValidatedPlanProposal,
  capturePlanProposalBase,
  encodePlanProposalBase,
  encodePlanProposalMutation,
  PlanProposalError,
  projectPlanProposalDiff,
  revalidatePlanProposalPremises,
  validatePlanProposal,
  type PlanProposalMutation,
} from "../../src/index.js";

const id = (suffix: number): string => `${"0".repeat(25)}${suffix}`;
const plan: PlanRecord = {
  id: id(1),
  originId: null,
  name: "Gran Fondo Plan",
  primaryGoal: "Finish",
  startDateKey: 20260824,
  targetDateKey: null,
  status: "active",
  kind: "short_race_preparation",
  totalWeeks: 4,
  weekStartDay: 1,
  structureJson: "{}",
  createdAtMs: 1,
  updatedAtMs: 10,
  deviceId: "device-1",
  hlcPhysicalMs: 10,
  hlcCounter: 0,
};
const workout: PlanWorkoutRecord = {
  id: id(2),
  planId: plan.id,
  dateKey: 20260830,
  sport: "cycling",
  name: "Endurance",
  durationS: 5_400,
  structureJson: "{}",
  origin: "coach",
  deviceId: "device-1",
  hlcPhysicalMs: 10,
  hlcCounter: 0,
};
const mutation: PlanProposalMutation = {
  schemaVersion: 1,
  changes: [
    {
      workoutId: workout.id,
      before: {
        dateKey: workout.dateKey,
        sport: workout.sport,
        name: workout.name,
        durationS: workout.durationS,
        structureJson: workout.structureJson,
      },
      after: {
        dateKey: workout.dateKey,
        sport: workout.sport,
        name: "Recovery",
        durationS: 1_800,
        structureJson: workout.structureJson,
      },
    },
  ],
  weekLoad: { before: 420, after: 360 },
};
const proposal: PlanProposalRecord = {
  id: id(3),
  planId: plan.id,
  parentProposalId: null,
  revision: 1,
  status: "proposed",
  title: "Sunday recovery",
  rationale: "Saturday fatigue is 12 above your normal range.",
  confidence: "High",
  mutationJson: encodePlanProposalMutation(mutation),
  baseSnapshotJson: encodePlanProposalBase(capturePlanProposalBase(plan, [workout])),
  refusalReason: null,
  createdAtMs: 20,
  updatedAtMs: 20,
  resolvedAtMs: null,
  deviceId: "device-1",
  hlcPhysicalMs: 20,
  hlcCounter: 0,
};
const premise: PlanProposalPremiseRecord = {
  id: id(4),
  proposalId: proposal.id,
  sourceType: "activity",
  sourceId: "ride-21-aug",
  sourceLabel: "Saturday ride · 21 Aug",
  sourceDateKey: 20260821,
  confidence: "High",
  snapshotJson: '{"loadAboveNormal":12}',
  createdAtMs: 20,
  deviceId: "device-1",
  hlcPhysicalMs: 20,
  hlcCounter: 0,
};

const calculateWeekLoad = (workouts: readonly PlanWorkoutRecord[]): number => {
  const duration = workouts[0]?.durationS;
  return duration === 5_400 ? 420 : duration === 1_800 ? 360 : 0;
};

describe("structured Plan proposals", () => {
  it("renders an exact deterministic diff from the mutation rather than prose", () => {
    const result = validatePlanProposal({
      proposal,
      premises: [premise],
      plan,
      workouts: [workout],
      todayDateKey: 20260826,
      calculateWeekLoad,
    });
    expect(result.diff).toEqual([
      { field: "duration", label: "Duration", before: "1:30", after: "0:30" },
      { field: "workout", label: "Workout", before: "Endurance", after: "Recovery" },
      { field: "week-load", label: "Week load", before: "420", after: "360" },
    ]);
  });

  it("preserves seconds when a duration change is not minute-aligned", () => {
    expect(
      projectPlanProposalDiff({
        schemaVersion: 1,
        changes: [
          {
            workoutId: workout.id,
            before: { ...mutation.changes[0]!.before, durationS: 1_800 },
            after: {
              ...mutation.changes[0]!.before,
              durationS: 1_830,
            },
          },
        ],
        weekLoad: null,
      }),
    ).toEqual([{ field: "duration", label: "Duration", before: "0:30", after: "0:30:30" }]);
  });

  it("refuses malformed, stale, past, and athlete-owned changes before render or apply", () => {
    expect(() =>
      validatePlanProposal({
        proposal: { ...proposal, mutationJson: '{"freeText":"make Sunday easy"}' },
        premises: [premise],
        plan,
        workouts: [workout],
        todayDateKey: 20260826,
        calculateWeekLoad,
      }),
    ).toThrowError(PlanProposalError);
    const invalidMutationDate = JSON.parse(proposal.mutationJson) as {
      changes: Array<{ after: { dateKey: number } }>;
    };
    invalidMutationDate.changes[0]!.after.dateKey = 20260931;
    expect(() =>
      validatePlanProposal({
        proposal: { ...proposal, mutationJson: JSON.stringify(invalidMutationDate) },
        premises: [premise],
        plan,
        workouts: [workout],
        todayDateKey: 20260826,
        calculateWeekLoad,
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid-mutation" }));
    const invalidBaseDate = JSON.parse(proposal.baseSnapshotJson) as {
      workouts: Array<{ dateKey: number }>;
    };
    invalidBaseDate.workouts[0]!.dateKey = 20260931;
    expect(() =>
      validatePlanProposal({
        proposal: { ...proposal, baseSnapshotJson: JSON.stringify(invalidBaseDate) },
        premises: [premise],
        plan,
        workouts: [workout],
        todayDateKey: 20260826,
        calculateWeekLoad,
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid-base" }));
    expect(() =>
      validatePlanProposal({
        proposal,
        premises: [premise],
        plan: { ...plan, updatedAtMs: 11 },
        workouts: [workout],
        todayDateKey: 20260826,
        calculateWeekLoad,
      }),
    ).toThrowError(expect.objectContaining({ code: "stale-base" }));
    expect(() =>
      validatePlanProposal({
        proposal,
        premises: [premise],
        plan: { ...plan, hlcCounter: 1 },
        workouts: [workout],
        todayDateKey: 20260826,
        calculateWeekLoad,
      }),
    ).toThrowError(expect.objectContaining({ code: "stale-base" }));
    expect(() =>
      validatePlanProposal({
        proposal,
        premises: [premise],
        plan,
        workouts: [{ ...workout, origin: "athlete" }],
        todayDateKey: 20260826,
        calculateWeekLoad,
      }),
    ).toThrowError(PlanProposalError);
  });

  it("refuses hidden workout fields, multi-workout payloads, and unverified load claims", () => {
    const parsed = JSON.parse(proposal.mutationJson) as {
      changes: Array<{ after: { sport: string; structureJson: string } }>;
      weekLoad: { before: number; after: number };
    };
    parsed.changes[0]!.after.structureJson = '{"hidden":"intervals"}';
    expect(() =>
      validatePlanProposal({
        proposal: { ...proposal, mutationJson: JSON.stringify(parsed) },
        premises: [premise],
        plan,
        workouts: [workout],
        todayDateKey: 20260826,
        calculateWeekLoad,
      }),
    ).toThrowError(PlanProposalError);
    parsed.changes[0]!.after.structureJson = workout.structureJson;
    parsed.weekLoad.after = 359;
    expect(() =>
      validatePlanProposal({
        proposal: { ...proposal, mutationJson: JSON.stringify(parsed) },
        premises: [premise],
        plan,
        workouts: [workout],
        todayDateKey: 20260826,
        calculateWeekLoad,
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid-mutation" }));
    const original = JSON.parse(proposal.mutationJson) as { changes: unknown[] };
    original.changes.push(original.changes[0]);
    expect(() =>
      validatePlanProposal({
        proposal: { ...proposal, mutationJson: JSON.stringify(original) },
        premises: [premise],
        plan,
        workouts: [workout],
        todayDateKey: 20260826,
        calculateWeekLoad,
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid-mutation" }));
  });

  it("refuses semantic changes that would retain stale executable workout content", () => {
    const structureJson = JSON.stringify({
      description: "Ninety-minute endurance ride.",
      workoutDoc: { steps: [{ durationS: 5_400, target: "endurance" }] },
    });
    const structuredWorkout = { ...workout, structureJson };
    const structuredMutation: PlanProposalMutation = {
      ...mutation,
      changes: [
        {
          ...mutation.changes[0]!,
          before: { ...mutation.changes[0]!.before, structureJson },
          after: { ...mutation.changes[0]!.after, structureJson },
        },
      ],
    };
    const structuredProposal = {
      ...proposal,
      mutationJson: encodePlanProposalMutation(structuredMutation),
      baseSnapshotJson: encodePlanProposalBase(capturePlanProposalBase(plan, [structuredWorkout])),
    };

    expect(() =>
      validatePlanProposal({
        proposal: structuredProposal,
        premises: [premise],
        plan,
        workouts: [structuredWorkout],
        todayDateKey: 20260826,
        calculateWeekLoad,
      }),
    ).toThrowError(expect.objectContaining({ code: "unsafe-workout" }));
  });

  it("reports a thrown load calculator as an unavailable capability", () => {
    expect(() =>
      validatePlanProposal({
        proposal,
        premises: [premise],
        plan,
        workouts: [workout],
        todayDateKey: 20260826,
        calculateWeekLoad: () => {
          throw new Error("calculator unavailable");
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "missing-capability" }));
  });

  it("rechecks every cited premise against its current canonical snapshot", async () => {
    await expect(
      revalidatePlanProposalPremises([premise], {
        read: vi.fn(async () => '{"loadAboveNormal":12}'),
      }),
    ).resolves.toBeUndefined();
    await expect(
      revalidatePlanProposalPremises([premise], {
        read: vi.fn(async () => '{"loadAboveNormal":9}'),
      }),
    ).rejects.toMatchObject({ code: "stale-base" });
    await expect(
      revalidatePlanProposalPremises([premise], { read: vi.fn(async () => null) }),
    ).rejects.toMatchObject({ code: "stale-base" });
  });

  it("applies only the validated revision through the atomic repository boundary", async () => {
    const validated = validatePlanProposal({
      proposal,
      premises: [premise],
      plan,
      workouts: [workout],
      todayDateKey: 20260826,
      calculateWeekLoad,
    });
    const apply = vi.fn(async () => ({ ...proposal, status: "applied" as const }));
    const repository = { apply } as unknown as PlanProposalRepository;
    await applyValidatedPlanProposal(validated, {
      repository,
      plan,
      resolvedAtMs: 30,
      deviceId: "device-1",
      hlcPhysicalMs: 30,
      hlcCounter: 0,
      ledgerId: id(8),
      mirrorJob: {
        id: id(9),
        windowStartDateKey: 20260826,
        windowEndDateKey: 20260901,
        createdAtMs: 30,
      },
    });
    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedPlanUpdatedAtMs: 10,
        expectedPlanHlcPhysicalMs: 10,
        expectedPlanHlcCounter: 0,
        workouts: [expect.objectContaining({ name: "Recovery", durationS: 1_800 })],
        ledger: expect.objectContaining({
          id: id(8),
          kind: "proposal-applied",
          weekLoadBefore: 420,
          weekLoadAfter: 360,
        }),
      }),
    );
  });
});
