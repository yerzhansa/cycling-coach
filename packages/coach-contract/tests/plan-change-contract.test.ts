import { describe, expect, it } from "vitest";
import {
  COACH_RPC_METHOD_REGISTRY,
  CoachRpcRequestEnvelopeSchema,
  ListPlansResultSchema,
  PlanChangeApplyResultSchema,
  PlanChangeApplyRpcParamsSchema,
  PlanChangeIntentSchema,
  PlanChangeModelSchema,
  PlanChangePreviewResultSchema,
  PlanChangePreviewRpcParamsSchema,
  PlanChangeWorkoutSchema,
  PlanCreationDraftSchema,
} from "../src/index.js";

const planId = "01J00000000000000000000001";
const changeId = "01J00000000000000000000002";
const command = { commandId: "change-command", planId, expectedVersion: 1 };
const intent = { kind: "weekday-duration", day: 3, minutes: 30 };
const workout = {
  id: "workout-one",
  name: "Endurance ride",
  kind: "endurance",
  date: "1998-09-09",
  minutes: 60,
  pinned: false,
  guidance: "Ride comfortably.",
  power: null,
};
const change = {
  changeId,
  planId,
  baseRevisionNumber: 1,
  status: "pending",
  title: "Limit weekday duration",
  intent,
  diff: [{ workoutId: workout.id, before: workout, after: { ...workout, minutes: 30 } }],
  totals: {
    before: { plan: 60, weeks: [{ number: 1, minutes: 60 }] },
    after: { plan: 30, weeks: [{ number: 1, minutes: 30 }] },
  },
  supersedes: null,
  supersededBy: null,
  resultRevisionNumber: null,
  confidence:
    "Moderate confidence. Based on your confirmed limits and the available training record.",
  premises: [
    {
      id: "confirmed-limits",
      label: "Confirmed Plan limits",
      source: "Your confirmed answers",
      value: intent,
    },
  ],
};

describe("Plan Change contract", () => {
  it.each([
    intent,
    { kind: "weekday-unavailable", day: 7 },
    { kind: "hard-weekday", day: 1 },
    { kind: "weekly-duration", hours: 2.5 },
    { kind: "longest-workout", minutes: 45 },
  ])("accepts Schedule intent $kind", (value) => {
    expect(PlanChangeIntentSchema.parse(value)).toEqual(value);
  });

  it.each([
    { ...intent, day: 0 },
    { ...intent, day: 8 },
    { ...intent, day: 1.5 },
    { ...intent, minutes: 0 },
    { ...intent, minutes: -1 },
    { kind: "weekly-duration", hours: 0 },
    { kind: "longest-workout", minutes: Infinity },
    { kind: "hard-weekday", day: 3, minutes: 30 },
    { kind: "inverse" },
    { kind: "ftp", ftp: 220 },
  ])("rejects invalid or deferred intent %j", (value) => {
    expect(PlanChangeIntentSchema.safeParse(value).success).toBe(false);
  });

  it("reuses the Draft Workout schema and preserves exact differences and premises", () => {
    expect(PlanChangeWorkoutSchema).toBe(
      PlanCreationDraftSchema.shape.weeks.element.shape.workouts.element,
    );
    expect(PlanChangeModelSchema.parse(change)).toEqual(change);
    expect(
      PlanChangeModelSchema.parse({
        ...change,
        diff: [{ workoutId: workout.id, before: workout, after: null }],
      }).diff[0]?.after,
    ).toBeNull();
    expect(
      PlanChangeModelSchema.parse({
        ...change,
        diff: [{ workoutId: workout.id, before: null, after: workout }],
      }).diff[0]?.before,
    ).toBeNull();
  });

  it.each(["pending", "applied", "cancelled", "superseded", "stale"])(
    "accepts athlete status %s",
    (status) => {
      expect(PlanChangeModelSchema.parse({ ...change, status }).status).toBe(status);
    },
  );

  it("preserves the successor id in superseded history", () => {
    const superseded = {
      ...change,
      status: "superseded",
      supersededBy: "01J00000000000000000000003",
    };
    expect(PlanChangeModelSchema.parse(superseded)).toEqual(superseded);
  });

  it("requires explicit changes in the Plan list", () => {
    const empty = { creation: null, active: null, closed: [], changes: [] };
    expect(ListPlansResultSchema.parse(empty)).toEqual(empty);
    expect(
      ListPlansResultSchema.safeParse({ creation: null, active: null, closed: [] }).success,
    ).toBe(false);
  });

  it("registers strict preview and apply envelopes and result schemas", () => {
    const preview = { ...command, intent };
    const apply = { ...command, changeId, decision: "apply" };
    expect(PlanChangePreviewRpcParamsSchema.parse(preview)).toEqual(preview);
    expect(PlanChangeApplyRpcParamsSchema.parse(apply)).toEqual(apply);
    expect(PlanChangeApplyRpcParamsSchema.parse({ ...apply, decision: "cancel" }).decision).toBe(
      "cancel",
    );
    expect(PlanChangeApplyRpcParamsSchema.safeParse({ ...apply, decision: "undo" }).success).toBe(
      false,
    );
    expect(
      PlanChangePreviewRpcParamsSchema.safeParse({ ...preview, expectedVersion: 0 }).success,
    ).toBe(false);
    expect(PlanChangePreviewRpcParamsSchema.safeParse({ ...preview, extra: true }).success).toBe(
      false,
    );
    for (const [method, params] of [
      ["plan_change.preview", preview],
      ["plan_change.apply", apply],
    ]) {
      const envelope = { jsonrpc: "2.0", id: 1, method, params };
      expect(CoachRpcRequestEnvelopeSchema.parse(envelope)).toEqual(envelope);
    }
    expect(COACH_RPC_METHOD_REGISTRY["plan_change.preview"].requestSchema).toBe(
      PlanChangePreviewRpcParamsSchema,
    );
    expect(COACH_RPC_METHOD_REGISTRY["plan_change.preview"].responseSchema).toBe(
      PlanChangePreviewResultSchema,
    );
    expect(COACH_RPC_METHOD_REGISTRY["plan_change.apply"].responseSchema).toBe(
      PlanChangeApplyResultSchema,
    );
    expect(
      PlanChangePreviewResultSchema.parse({ status: "previewed", change, version: 1 }).status,
    ).toBe("previewed");
    expect(
      PlanChangeApplyResultSchema.parse({
        status: "applied",
        changeId,
        revisionNumber: 2,
        version: 2,
      }).status,
    ).toBe("applied");
    expect(
      PlanChangeApplyResultSchema.parse({ status: "cancelled", changeId, version: 1 }).status,
    ).toBe("cancelled");
  });

  it.each(["stale-version", "no-active-plan", "command-conflict", "invalid-intent"])(
    "accepts preview rejection %s",
    (reason) => {
      expect(PlanChangePreviewResultSchema.parse({ status: "rejected", reason })).toEqual({
        status: "rejected",
        reason,
      });
    },
  );

  it.each(["stale-version", "not-pending", "no-active-plan", "command-conflict"])(
    "accepts apply rejection %s",
    (reason) => {
      expect(PlanChangeApplyResultSchema.parse({ status: "rejected", reason })).toEqual({
        status: "rejected",
        reason,
      });
    },
  );
});
