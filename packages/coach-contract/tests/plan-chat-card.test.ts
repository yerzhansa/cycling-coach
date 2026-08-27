import { describe, expect, it } from "vitest";
import {
  PlanChatCardReadModelSchema,
  PlanHandoffSuggestionSchema,
  PlanReferenceSelectionSchema,
  TranscriptPageTurnSchema,
  TurnEventSchema,
} from "../src/index.js";

const selection = { kind: "workout_detail" as const, planId: "plan-1", workoutId: "workout-1" };
const handoff = {
  kind: "plan_change" as const,
  title: "Review a lighter Friday",
  intent: "Move Friday's endurance Workout to Saturday and keep Friday easy.",
};

describe("Plan Chat card contract", () => {
  it("accepts strict persisted selections and rejects extra fields", () => {
    expect(PlanReferenceSelectionSchema.parse(selection)).toEqual(selection);
    expect(
      PlanReferenceSelectionSchema.safeParse({ ...selection, markup: "<button>Apply</button>" })
        .success,
    ).toBe(false);
  });

  it("requires the one Open Plan action to target the card entity", () => {
    const card = {
      kind: "workout_detail" as const,
      cardId: "plan:plan-1:workout:workout-1",
      planId: "plan-1",
      workoutId: "workout-1",
      title: "Tempo builder",
      summary: "cycling",
      dateKey: 20260826,
      durationMinutes: 60,
      targets: "3 × 8 min · 85–90% FTP",
      purpose: "Sustainable power",
      safetyGuardrail: "Stop if the warm-up feels wrong",
      applicationState: "current" as const,
      action: {
        label: "Open Plan" as const,
        target: { destination: "plan" as const, focus: "workout" as const, entityId: "workout-1" },
      },
    };
    expect(PlanChatCardReadModelSchema.parse(card)).toEqual(card);
    expect(
      PlanChatCardReadModelSchema.safeParse({
        ...card,
        action: { ...card.action, target: { ...card.action.target, entityId: "workout-2" } },
      }).success,
    ).toBe(false);
  });

  it("carries the same selection through live events and transcript pages", () => {
    expect(
      TurnEventSchema.parse({ type: "plan-reference", turnId: "turn-1", selection }),
    ).toMatchObject({ selection });
    expect(
      TranscriptPageTurnSchema.parse({
        turnId: "turn-1",
        completedAt: "2026-08-26T00:00:00.000Z",
        athleteText: "What is tomorrow?",
        coachText: "Tempo builder.",
        planReference: selection,
      }),
    ).toMatchObject({ planReference: selection });
  });

  it("carries one strict Plan handoff suggestion through live events and transcript pages", () => {
    expect(PlanHandoffSuggestionSchema.parse(handoff)).toEqual(handoff);
    expect(
      PlanHandoffSuggestionSchema.safeParse({ ...handoff, markup: "<button>Apply</button>" })
        .success,
    ).toBe(false);
    expect(
      TurnEventSchema.parse({ type: "plan-handoff", turnId: "turn-1", suggestion: handoff }),
    ).toMatchObject({ suggestion: handoff });
    expect(
      TranscriptPageTurnSchema.parse({
        turnId: "turn-1",
        completedAt: "2026-08-26T00:00:00.000Z",
        athleteText: "Can we move Friday?",
        coachText: "Review this change in Plan.",
        planHandoff: handoff,
      }),
    ).toMatchObject({ planHandoff: handoff });
  });
});
