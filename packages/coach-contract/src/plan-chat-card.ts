import { z } from "zod";
import {
  ActivePlanReadModelSchema,
  PlanDateKeySchema,
  PlanNavigationTargetSchema,
  PlanWorkoutReadModelSchema,
} from "./planning-read.js";

const PlanEntityIdSchema = z.string().min(1).max(256);

export const PlanReferenceSelectionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("active_plan_summary"),
      planId: PlanEntityIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("current_week"),
      planId: PlanEntityIdSchema,
      weekNumber: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("workout_detail"),
      planId: PlanEntityIdSchema,
      workoutId: PlanEntityIdSchema,
    })
    .strict(),
]);
export type PlanReferenceSelection = z.infer<typeof PlanReferenceSelectionSchema>;

export const RequestPlanReferenceInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("active_plan_summary") }).strict(),
  z.object({ kind: z.literal("current_week") }).strict(),
  z
    .object({
      kind: z.literal("workout_detail"),
      workoutId: PlanEntityIdSchema,
    })
    .strict(),
]);
export type RequestPlanReferenceInput = z.infer<typeof RequestPlanReferenceInputSchema>;

export const PlanReferenceToolResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("unavailable"),
      reason: z.enum(["no-plan", "outside-plan-dates", "workout-not-found"]),
    })
    .strict(),
  z
    .object({
      status: z.literal("ready"),
      selection: PlanReferenceSelectionSchema,
      plan: ActivePlanReadModelSchema,
      workout: PlanWorkoutReadModelSchema.nullable(),
    })
    .strict(),
]);
export type PlanReferenceToolResult = z.infer<typeof PlanReferenceToolResultSchema>;

const OpenPlanActionSchema = z
  .object({
    label: z.literal("Open Plan"),
    target: PlanNavigationTargetSchema,
  })
  .strict();

const PlanChatCardBaseShape = {
  cardId: z.string().min(1).max(768),
  title: z.string().min(1).max(500),
  summary: z.string().min(1).max(2_000),
  action: OpenPlanActionSchema,
};

export const PlanChatCardReadModelSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        ...PlanChatCardBaseShape,
        kind: z.literal("active_plan_summary"),
        planId: PlanEntityIdSchema,
        lifecycle: z.enum(["draft", "active"]),
        currentWeek: z.number().int().positive(),
        totalWeeks: z.number().int().positive(),
        phase: z.string().min(1).max(500),
      })
      .strict(),
    z
      .object({
        ...PlanChatCardBaseShape,
        kind: z.literal("current_week"),
        planId: PlanEntityIdSchema,
        weekNumber: z.number().int().positive(),
        totalWeeks: z.number().int().positive(),
        phase: z.string().min(1).max(500),
        workouts: z.array(PlanWorkoutReadModelSchema).max(31),
      })
      .strict(),
    z
      .object({
        ...PlanChatCardBaseShape,
        kind: z.literal("workout_detail"),
        planId: PlanEntityIdSchema,
        workoutId: PlanEntityIdSchema,
        dateKey: PlanDateKeySchema,
        durationMinutes: z.number().int().nonnegative().nullable(),
        targets: z.string().min(1).max(2_000),
        purpose: z.string().min(1).max(2_000),
        safetyGuardrail: z.string().min(1).max(2_000),
        applicationState: z.literal("current"),
      })
      .strict(),
  ])
  .superRefine((value, context) => {
    const expected =
      value.kind === "active_plan_summary"
        ? { focus: "active-plan" as const, entityId: value.planId }
        : value.kind === "current_week"
          ? { focus: "current-week" as const, entityId: value.planId }
          : { focus: "workout" as const, entityId: value.workoutId };
    if (
      value.action.target.focus !== expected.focus ||
      value.action.target.entityId !== expected.entityId
    ) {
      context.addIssue({
        code: "custom",
        path: ["action", "target"],
        message: "Open Plan action must target the card's Planning entity",
      });
    }
  });
export type PlanChatCardReadModel = z.infer<typeof PlanChatCardReadModelSchema>;
