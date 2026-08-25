import { z } from "zod";

export type WorkoutSourceFormat = "zwo" | "mrc" | "erg";

export interface WorkoutParserLimits {
  readonly candidates: number;
  readonly segmentsPerWorkout: number;
  readonly durationSeconds: number;
  readonly diagnostics: number;
  readonly diagnosticChars: number;
  readonly titleChars: number;
  readonly purposeChars: number;
}

export type WorkoutPowerTarget =
  | { readonly kind: "ftp_fraction_range"; readonly low: number; readonly high: number }
  | { readonly kind: "ftp_percent_range"; readonly low: number; readonly high: number }
  | { readonly kind: "watts_range"; readonly low: number; readonly high: number };

export interface WorkoutCadenceRange {
  readonly low: number;
  readonly high: number;
}

export interface NormalizedWorkoutSegment {
  readonly segmentId: string;
  readonly kind: "steady" | "ramp" | "free_ride";
  readonly seconds: number;
  readonly power?: WorkoutPowerTarget;
  readonly cadenceRpm?: WorkoutCadenceRange;
}

export interface NormalizedWorkout {
  readonly workoutId: string;
  readonly title: string;
  readonly sport: "cycling";
  readonly durationSeconds: number;
  readonly purpose: string | null;
  readonly segments: readonly NormalizedWorkoutSegment[];
}

export interface NormalizedWorkoutSet {
  readonly schemaVersion: 1;
  readonly setId: string;
  readonly sourceFormat: WorkoutSourceFormat;
  readonly parserVersion: string;
  readonly selectedWorkoutId: string | null;
  readonly workouts: readonly NormalizedWorkout[];
  readonly diagnostics: readonly string[];
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
}

export function validateWorkoutParserLimits(limits: WorkoutParserLimits): void {
  positiveInteger(limits.candidates, "candidates");
  positiveInteger(limits.segmentsPerWorkout, "segmentsPerWorkout");
  positiveInteger(limits.durationSeconds, "durationSeconds");
  positiveInteger(limits.diagnostics, "diagnostics");
  positiveInteger(limits.diagnosticChars, "diagnosticChars");
  positiveInteger(limits.titleChars, "titleChars");
  positiveInteger(limits.purposeChars, "purposeChars");
}

export function normalizedWorkoutSetSchema(limits: WorkoutParserLimits) {
  validateWorkoutParserLimits(limits);
  const id = z.string().min(1).max(128);
  const rangeShape = { low: z.number().positive().finite(), high: z.number().positive().finite() };
  const range = z
    .object(rangeShape)
    .strict()
    .refine((value) => value.low <= value.high, { message: "range must be ordered" });
  const power = z
    .discriminatedUnion("kind", [
      z.object({ ...rangeShape, kind: z.literal("ftp_fraction_range") }).strict(),
      z.object({ ...rangeShape, kind: z.literal("ftp_percent_range") }).strict(),
      z.object({ ...rangeShape, kind: z.literal("watts_range") }).strict(),
    ])
    .superRefine((value, context) => {
      if (value.low > value.high) {
        context.addIssue({ code: "custom", path: ["high"], message: "range must be ordered" });
      }
    });
  const segment = z
    .object({
      segmentId: id,
      kind: z.enum(["steady", "ramp", "free_ride"]),
      seconds: z.number().int().positive(),
      power: power.optional(),
      cadenceRpm: range.optional(),
    })
    .strict()
    .superRefine((value, context) => {
      if (value.kind !== "free_ride" && value.power === undefined) {
        context.addIssue({
          code: "custom",
          path: ["power"],
          message: "targeted segment requires power",
        });
      }
    });
  const workout = z
    .object({
      workoutId: id,
      title: z.string().min(1).max(limits.titleChars),
      sport: z.literal("cycling"),
      durationSeconds: z.number().int().positive().max(limits.durationSeconds),
      purpose: z.string().min(1).max(limits.purposeChars).nullable(),
      segments: z.array(segment).min(1).max(limits.segmentsPerWorkout),
    })
    .strict()
    .superRefine((value, context) => {
      if (
        value.segments.reduce((total, current) => total + current.seconds, 0) !==
        value.durationSeconds
      ) {
        context.addIssue({
          code: "custom",
          path: ["durationSeconds"],
          message: "duration must equal segment sum",
        });
      }
    });
  return z
    .object({
      schemaVersion: z.literal(1),
      setId: id,
      sourceFormat: z.enum(["zwo", "mrc", "erg"]),
      parserVersion: z.string().min(1).max(128),
      selectedWorkoutId: id.nullable(),
      workouts: z.array(workout).min(1).max(limits.candidates),
      diagnostics: z.array(z.string().min(1).max(limits.diagnosticChars)).max(limits.diagnostics),
    })
    .strict()
    .superRefine((value, context) => {
      const ids = value.workouts.map((candidate) => candidate.workoutId);
      if (new Set(ids).size !== ids.length) {
        context.addIssue({ code: "custom", path: ["workouts"], message: "duplicate workout id" });
      }
      if (value.selectedWorkoutId !== null && !ids.includes(value.selectedWorkoutId)) {
        context.addIssue({
          code: "custom",
          path: ["selectedWorkoutId"],
          message: "selected workout must exist",
        });
      }
    });
}

export function parseNormalizedWorkoutSet(
  value: unknown,
  limits: WorkoutParserLimits,
): NormalizedWorkoutSet {
  return normalizedWorkoutSetSchema(limits).parse(value) as NormalizedWorkoutSet;
}
