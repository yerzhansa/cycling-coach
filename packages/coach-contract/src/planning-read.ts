import { z } from "zod";

export const PlanDateKeySchema = z.number().int().min(1_000_101).max(99_991_231);

export const PlanNavigationTargetSchema = z
  .object({
    destination: z.literal("plan"),
    focus: z.enum(["active-plan", "current-week", "workout"]),
    entityId: z.string().min(1).nullable(),
  })
  .strict();
export type PlanNavigationTarget = z.infer<typeof PlanNavigationTargetSchema>;

export const PlanWorkoutReadModelSchema = z
  .object({
    id: z.string().min(1),
    dateKey: PlanDateKeySchema,
    sport: z.string().min(1),
    name: z.string().min(1),
    durationSeconds: z.number().int().nonnegative().nullable(),
    origin: z.enum(["coach", "athlete"]),
    navigation: PlanNavigationTargetSchema,
  })
  .strict();
export type PlanWorkoutReadModel = z.infer<typeof PlanWorkoutReadModelSchema>;

export const ActivePlanReadModelSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    goal: z.string(),
    lifecycle: z.enum(["draft", "active"]),
    startDateKey: PlanDateKeySchema,
    targetDateKey: PlanDateKeySchema.nullable(),
    currentWeek: z.number().int().positive().nullable(),
    totalWeeks: z.number().int().positive(),
    phase: z.string().min(1).nullable(),
    weekStartDateKey: PlanDateKeySchema.nullable(),
    weekEndDateKey: PlanDateKeySchema.nullable(),
    workouts: z.array(PlanWorkoutReadModelSchema),
    todayWorkout: PlanWorkoutReadModelSchema.nullable(),
    navigation: PlanNavigationTargetSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const hasWeek = value.currentWeek !== null;
    if (hasWeek !== (value.weekStartDateKey !== null && value.weekEndDateKey !== null)) {
      context.addIssue({
        code: "custom",
        path: ["currentWeek"],
        message: "current week and its date range must appear together",
      });
    }
    if (value.todayWorkout !== null && !value.workouts.some((item) => item.id === value.todayWorkout?.id)) {
      context.addIssue({
        code: "custom",
        path: ["todayWorkout"],
        message: "today workout must belong to the current week",
      });
    }
  });
export type ActivePlanReadModel = z.infer<typeof ActivePlanReadModelSchema>;

export const PlanningReadModelSchema = z.discriminatedUnion("status", [
  z
    .object({
      schemaVersion: z.literal(1),
      status: z.literal("no-plan"),
      asOfDateKey: PlanDateKeySchema,
      plan: z.null(),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      status: z.literal("ready"),
      asOfDateKey: PlanDateKeySchema,
      plan: ActivePlanReadModelSchema,
    })
    .strict(),
]);
export type PlanningReadModel = z.infer<typeof PlanningReadModelSchema>;

export const GetPlanningReadModelRpcParamsSchema = z.object({}).strict();
export type GetPlanningReadModelRpcParams = z.infer<typeof GetPlanningReadModelRpcParamsSchema>;
export const GetPlanningReadModelRpcResultSchema = PlanningReadModelSchema;
export type GetPlanningReadModelRpcResult = z.infer<typeof GetPlanningReadModelRpcResultSchema>;

export interface PlanningReadOperations {
  getPlanningReadModel?(
    request: GetPlanningReadModelRpcParams,
  ): Promise<GetPlanningReadModelRpcResult>;
}
