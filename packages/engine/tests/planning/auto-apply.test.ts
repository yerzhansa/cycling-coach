import { describe, expect, it } from "vitest";
import type { PlanRecord, PlanWorkoutRecord } from "@enduragent/kernel/planning";
import {
  capturePlanProposalBase,
  encodePlanProposalBase,
  encodePlanProposalMutation,
  validatePlanAutoApply,
  validatePlanProposal,
  type PlanProposalMutation,
} from "../../src/index.js";

const PLAN_ID = `${"0".repeat(25)}1`;
const WORKOUT_ID = `${"0".repeat(25)}2`;
const PROPOSAL_ID = `${"0".repeat(25)}3`;

function plan(overrides: Partial<PlanRecord> = {}): PlanRecord {
  return {
    id: PLAN_ID,
    originId: null,
    name: "Gran Fondo",
    primaryGoal: "Finish",
    startDateKey: 20260713,
    targetDateKey: 20261004,
    status: "active",
    kind: "full_plan",
    totalWeeks: 12,
    weekStartDay: 1,
    structureJson: JSON.stringify({
      phases: [
        { focus: "base", durationWeeks: 4 },
        { focus: "build", durationWeeks: 6 },
        { focus: "taper", durationWeeks: 2 },
      ],
    }),
    createdAtMs: 1,
    updatedAtMs: 10,
    deviceId: "device-1",
    hlcPhysicalMs: 10,
    hlcCounter: 0,
    ...overrides,
  };
}

function workout(overrides: Partial<PlanWorkoutRecord> = {}): PlanWorkoutRecord {
  return {
    id: WORKOUT_ID,
    planId: PLAN_ID,
    dateKey: 20260830,
    sport: "cycling",
    name: "Endurance",
    durationS: 5_400,
    structureJson: "{}",
    origin: "coach",
    deviceId: "device-1",
    hlcPhysicalMs: 10,
    hlcCounter: 0,
    ...overrides,
  };
}

function validated(input: {
  readonly plan?: PlanRecord;
  readonly workout?: PlanWorkoutRecord;
  readonly after?: Partial<PlanWorkoutRecord>;
}) {
  const currentPlan = input.plan ?? plan();
  const current = input.workout ?? workout();
  const after = { ...current, durationS: 2_700, ...input.after };
  const mutation: PlanProposalMutation = {
    schemaVersion: 1,
    changes: [
      {
        workoutId: current.id,
        before: {
          dateKey: current.dateKey,
          sport: current.sport,
          name: current.name,
          durationS: current.durationS,
          structureJson: current.structureJson,
        },
        after: {
          dateKey: after.dateKey,
          sport: after.sport,
          name: after.name,
          durationS: after.durationS,
          structureJson: after.structureJson,
        },
      },
    ],
    weekLoad: null,
  };
  return validatePlanProposal({
    proposal: {
      id: PROPOSAL_ID,
      planId: currentPlan.id,
      parentProposalId: null,
      revision: 1,
      status: "proposed",
      title: "Reduce Sunday",
      rationale: "Recovery",
      confidence: "High",
      mutationJson: encodePlanProposalMutation(mutation),
      baseSnapshotJson: encodePlanProposalBase(capturePlanProposalBase(currentPlan, [current])),
      refusalReason: null,
      createdAtMs: 10,
      updatedAtMs: 10,
      resolvedAtMs: null,
      deviceId: "device-1",
      hlcPhysicalMs: 10,
      hlcCounter: 0,
    },
    premises: [
      {
        id: `${"0".repeat(25)}4`,
        proposalId: PROPOSAL_ID,
        sourceType: "wellness",
        sourceId: "wellness-1",
        sourceLabel: "Wellness",
        sourceDateKey: 20260829,
        confidence: "High",
        snapshotJson: "{}",
        createdAtMs: 10,
        deviceId: "device-1",
        hlcPhysicalMs: 10,
        hlcCounter: 0,
      },
    ],
    plan: currentPlan,
    workouts: [current],
    todayDateKey: 20260826,
  });
}

describe("Plan reduction-only Auto-apply", () => {
  it("allows one future duration reduction outside taper and the race window", () => {
    expect(validatePlanAutoApply({ enabled: true, plan: plan(), proposal: validated({}) })).toEqual(
      {
        status: "eligible",
      },
    );
  });

  it.each([
    ["disabled", { enabled: false }],
    ["not-a-reduction", { after: { durationS: 6_000 } }],
    ["week-structure", { after: { dateKey: 20260831 } }],
    ["week-structure", { after: { name: "Recovery" } }],
    ["race-window", { workout: workout({ dateKey: 20260928 }) }],
    ["taper", { workout: workout({ dateKey: 20260921 }) }],
    ["safety-context-unavailable", { plan: plan({ structureJson: "{}" }) }],
  ] as const)("falls back to approval for %s", (reason, values) => {
    const enabled = "enabled" in values ? values.enabled : true;
    expect(
      validatePlanAutoApply({
        enabled,
        plan: "plan" in values ? values.plan : plan(),
        proposal: validated("enabled" in values ? {} : values),
      }),
    ).toEqual({ status: "approval-required", reason });
  });

  it("rejects a changed structured workout before it can enter Auto-apply", () => {
    expect(() => validated({ after: { structureJson: '{"steps":[]}' } })).toThrowError(
      "plan proposal failed: unsafe-workout",
    );
  });
});
