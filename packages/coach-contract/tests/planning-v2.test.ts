import { describe, expect, it } from "vitest";
import {
  PlanGetContextV2ResultSchema,
  PlanListV2ResultSchema,
  PlanningV2CommandResultSchema,
  PlanningV2CommandSchema,
  adaptLegacyPlanStatusToPlanningV2,
  adaptPlanningV2LifecycleToLegacy,
  type PlanningV2Command,
} from "../src/index.js";

const IDS = {
  plan: "00000000000000000000000001",
  creation: "00000000000000000000000002",
  draft: "00000000000000000000000003",
  change: "00000000000000000000000004",
  answer: "00000000000000000000000005",
  preference: "00000000000000000000000006",
  restriction: "00000000000000000000000007",
  evidence: "00000000000000000000000008",
} as const;

const DIGEST = "a".repeat(64);
const FINGERPRINT = "b".repeat(64);

const updatedCalendar = {
  status: "updated" as const,
  pendingOperations: 0,
  attentionCount: 0,
  lastSuccessfulSyncAtMs: 1_000,
};

const attentionCalendar = {
  status: "needs-attention" as const,
  pendingOperations: 0,
  attentionCount: 1,
  lastSuccessfulSyncAtMs: null,
};

const creation = {
  id: IDS.creation,
  version: 3,
  status: "review" as const,
  reviewState: "current" as const,
  name: "Gran Fondo Plan",
  goal: "Finish the Gran Fondo steadily",
  confirmedAnswers: 8,
  requiredAnswers: 8,
  currentDraftRevision: 1,
  updatedAtMs: 2_000,
  focusId: `plan-creation:${IDS.creation}`,
};

const activePlan = {
  id: IDS.plan,
  version: 2,
  revision: 2,
  name: "Base Plan",
  goal: "Build durable endurance",
  lifecycle: "active" as const,
  startDate: "1998-08-03",
  endDate: "1998-10-25",
  updatedAtMs: 2_000,
  calendar: attentionCalendar,
  focusId: `plan:${IDS.plan}`,
};

const closedPlan = {
  ...activePlan,
  id: "00000000000000000000000009",
  lifecycle: "closed" as const,
  closeReason: "stopped" as const,
  closedAtMs: 1_900,
  calendar: updatedCalendar,
};

describe("Planning v2 contract", () => {
  it("returns active, creation, and closed collections together", () => {
    const result = {
      schemaVersion: 2,
      asOfMs: 2_000,
      creation,
      activePlan,
      closedPlans: [closedPlan],
      nextClosedCursor: null,
      attention: { total: 2, creation: 1, activePlan: 0, calendar: 1 },
    };
    expect(PlanListV2ResultSchema.parse(result)).toEqual(result);
  });

  it("keeps lifecycle and Calendar status orthogonal", () => {
    const result = PlanListV2ResultSchema.parse({
      schemaVersion: 2,
      asOfMs: 2_000,
      creation: null,
      activePlan,
      closedPlans: [closedPlan],
      nextClosedCursor: null,
      attention: { total: 1, creation: 0, activePlan: 0, calendar: 1 },
    });
    expect(result.activePlan?.lifecycle).toBe("active");
    expect(result.activePlan?.calendar.status).toBe("needs-attention");
    expect(result.closedPlans[0]?.lifecycle).toBe("closed");
    expect(result.closedPlans[0]?.calendar.status).toBe("updated");
  });

  it("returns exact revisions and source-labelled context without diagnostic fields", () => {
    const result = {
      schemaVersion: 2,
      asOfMs: 2_000,
      detail: { kind: "plan-creation", creation, answers: [] },
      effectiveContext: [
        {
          answer: { kind: "text", questionId: "goal", value: "Finish steadily" },
          source: "athlete-preference",
          sourceId: IDS.preference,
          freshness: "current",
        },
      ],
      athletePreferences: [
        {
          id: IDS.preference,
          version: 1,
          answer: {
            kind: "schedule-preference",
            questionId: "schedule-preference",
            value: "flexible",
          },
          updatedAtMs: 1_000,
        },
      ],
      trainingRestrictions: [
        {
          id: IDS.restriction,
          version: 1,
          kind: "maximum-duration",
          startDate: "1998-08-10",
          endDate: "1998-08-16",
          maximumDurationMinutes: 60,
          confirmedAtMs: 1_000,
        },
      ],
      observedEvidence: [
        {
          id: IDS.evidence,
          questionId: "training-baseline",
          version: "capture-1",
          observedAtMs: 900,
          freshness: "current",
        },
      ],
      allowedCommands: ["plan_creation.answer", "plan_creation.activate"],
    };
    expect(PlanGetContextV2ResultSchema.parse(result)).toEqual(result);
    expect(
      PlanGetContextV2ResultSchema.safeParse({ ...result, diagnosis: "synthetic" }).success,
    ).toBe(false);
  });

  it("round-trips every strict named command and terminal result", () => {
    const base = { schemaVersion: 2 as const, commandId: "command-1", requestDigest: DIGEST };
    const commands: readonly PlanningV2Command[] = [
      { ...base, name: "plan_creation.start", intent: { kind: "new" } },
      {
        ...base,
        name: "plan_creation.answer",
        creationId: IDS.creation,
        expectedCreationVersion: 1,
        answer: { kind: "text", questionId: "goal", value: "Finish steadily" },
        confirmed: true,
        scope: "only-this-plan",
      },
      {
        ...base,
        name: "plan_creation.preview",
        creationId: IDS.creation,
        expectedCreationVersion: 2,
      },
      {
        ...base,
        name: "plan_creation.activate",
        creationId: IDS.creation,
        expectedCreationVersion: 3,
        draftId: IDS.draft,
        draftRevision: 1,
        draftFingerprint: FINGERPRINT,
      },
      {
        ...base,
        name: "plan_creation.discard",
        creationId: IDS.creation,
        expectedCreationVersion: 3,
      },
      {
        ...base,
        name: "plan_change.preview",
        planId: IDS.plan,
        expectedPlanVersion: 2,
        expectedPlanRevision: 2,
        intent: {
          kind: "adjust-load",
          direction: "reduce",
          effectiveDate: "1998-08-17",
          rationale: "Recover before the next build block",
        },
      },
      {
        ...base,
        name: "plan_change.apply",
        planId: IDS.plan,
        changeId: IDS.change,
        expectedChangeVersion: 1,
        expectedPlanVersion: 2,
        expectedPlanRevision: 2,
        previewFingerprint: FINGERPRINT,
      },
      {
        ...base,
        name: "plan.close",
        planId: IDS.plan,
        expectedPlanVersion: 2,
        expectedPlanRevision: 2,
        reason: "stopped",
        actor: "athlete",
      },
    ];
    for (const command of commands) {
      expect(PlanningV2CommandSchema.parse(command)).toEqual(command);
      const result = {
        ...base,
        name: command.name,
        status: "rejected",
        error: {
          code: "stale-revision",
          message: "Refresh the current Planning state.",
          retryable: true,
          currentVersion: 4,
          currentRevision: 3,
        },
      };
      expect(PlanningV2CommandResultSchema.parse(result)).toEqual(result);
    }
  });

  it("rejects extra fields and legacy public lifecycle or mutation terms", () => {
    const command = {
      schemaVersion: 2,
      name: "plan_creation.preview",
      commandId: "command-1",
      requestDigest: DIGEST,
      creationId: IDS.creation,
      expectedCreationVersion: 2,
    };
    expect(PlanningV2CommandSchema.safeParse({ ...command, transitionId: "PL-T01" }).success).toBe(
      false,
    );
    expect(
      PlanListV2ResultSchema.safeParse({
        schemaVersion: 2,
        asOfMs: 2_000,
        creation: null,
        activePlan: { ...activePlan, lifecycle: "ended" },
        closedPlans: [],
        nextClosedCursor: null,
        attention: { total: 0, creation: 0, activePlan: 0, calendar: 0 },
      }).success,
    ).toBe(false);
    expect(PlanningV2CommandSchema.safeParse({ ...command, name: "plan.replace" }).success).toBe(
      false,
    );
  });

  it("maps only truthful lifecycle compatibility", () => {
    expect(adaptLegacyPlanStatusToPlanningV2("draft")).toEqual({
      aggregate: "plan-creation",
      status: "review",
    });
    expect(adaptLegacyPlanStatusToPlanningV2("ended")).toEqual({
      aggregate: "plan",
      lifecycle: "closed",
      closeReason: "unavailable",
    });
    expect(
      adaptPlanningV2LifecycleToLegacy({
        aggregate: "plan",
        lifecycle: "closed",
        closeReason: "completed",
      }),
    ).toEqual({ status: "incompatible", reason: "close-reason-would-be-lost" });
    expect(
      adaptPlanningV2LifecycleToLegacy({
        aggregate: "plan",
        lifecycle: "closed",
        closeReason: "unavailable",
      }),
    ).toEqual({ status: "mapped", legacyStatus: "ended" });
  });
});
