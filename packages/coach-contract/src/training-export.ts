import { z } from "zod";
import { CanonicalActivityIdSchema } from "./activity-analysis.js";

export const ACTIVITY_EXPORT_FORMATS = ["fit", "gpx"] as const;
export const WORKOUT_ARCHIVE_FORMATS = ["zwo", "mrc", "erg", "fit"] as const;

export const ActivityExportFormatSchema = z.enum(ACTIVITY_EXPORT_FORMATS);
export const WorkoutArchiveFormatSchema = z.enum(WORKOUT_ARCHIVE_FORMATS);

function isCivilDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

export const TrainingExportCivilDateSchema = z
  .string()
  .refine(isCivilDate, "invalid training export civil date");

export const DesktopTrainingExportRequestSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("activity"),
      canonicalActivityId: CanonicalActivityIdSchema,
      localDate: TrainingExportCivilDateSchema,
      format: ActivityExportFormatSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("workout-archive"),
      oldest: TrainingExportCivilDateSchema,
      newest: TrainingExportCivilDateSchema,
      format: WorkoutArchiveFormatSchema,
    })
    .strict()
    .refine((value) => value.oldest <= value.newest, {
      message: "workout export date range is invalid",
      path: ["newest"],
    }),
]);

export const TrainingExportDestinationPathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine((value) => value.startsWith("/") && !value.includes("\0"), {
    message: "training export destination must be absolute",
  });

export const ExportTrainingFileRpcParamsSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("activity"),
      canonicalActivityId: CanonicalActivityIdSchema,
      format: ActivityExportFormatSchema,
      destinationPath: TrainingExportDestinationPathSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("workout-archive"),
      oldest: TrainingExportCivilDateSchema,
      newest: TrainingExportCivilDateSchema,
      format: WorkoutArchiveFormatSchema,
      destinationPath: TrainingExportDestinationPathSchema,
    })
    .strict()
    .refine((value) => value.oldest <= value.newest, {
      message: "workout export date range is invalid",
      path: ["newest"],
    }),
]);

export const TrainingExportRefusalReasonSchema = z.enum([
  "not-configured",
  "source-not-found",
  "ambiguous-source",
  "provider-unavailable",
  "not-supported",
  "rate-limited",
  "network",
  "timeout",
  "response-too-large",
  "invalid-response",
  "write-failed",
  "commit-uncertain",
]);

export const TrainingExportFilenameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (value) =>
      value !== "." &&
      value !== ".." &&
      !value.includes("/") &&
      !value.includes("\\") &&
      [...value].every((character) => {
        const codePoint = character.codePointAt(0)!;
        return codePoint > 31 && !(codePoint >= 127 && codePoint <= 159);
      }),
    "invalid training export filename",
  );

export const ExportTrainingFileRpcResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("exported"),
      byteLength: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      suggestedFilename: TrainingExportFilenameSchema.nullable(),
      contentType: z.string().min(1).max(255).nullable(),
    })
    .strict(),
  z
    .object({
      status: z.literal("refused"),
      reason: TrainingExportRefusalReasonSchema,
    })
    .strict(),
]);

export const DesktopTrainingExportResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("cancelled") }).strict(),
  z
    .object({
      status: z.literal("saved"),
      byteLength: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    })
    .strict(),
  z
    .object({
      status: z.literal("refused"),
      reason: TrainingExportRefusalReasonSchema,
    })
    .strict(),
]);

export type ActivityExportFormat = z.infer<typeof ActivityExportFormatSchema>;
export type WorkoutArchiveFormat = z.infer<typeof WorkoutArchiveFormatSchema>;
export type DesktopTrainingExportRequest = z.infer<typeof DesktopTrainingExportRequestSchema>;
export type ExportTrainingFileRpcParams = z.infer<typeof ExportTrainingFileRpcParamsSchema>;
export type TrainingExportRefusalReason = z.infer<typeof TrainingExportRefusalReasonSchema>;
export type ExportTrainingFileRpcResult = z.infer<typeof ExportTrainingFileRpcResultSchema>;
export type DesktopTrainingExportResult = z.infer<typeof DesktopTrainingExportResultSchema>;
