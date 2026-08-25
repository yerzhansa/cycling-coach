import { z } from "zod";
import { PlatformAbsolutePathSchema } from "./platform-path.js";

export const CHAT_ATTACHMENT_LIMITS = Object.freeze({
  attachmentsPerMessage: 5,
  messageBytes: 104_857_600,
  conversationBytes: 1_073_741_824,
  athleteBytes: 10_737_418_240,
  documentBytes: 26_214_400,
  activityBytes: 104_857_600,
  workoutBytes: 5_242_880,
  imageBytes: 20_971_520,
  extractedTextChars: 200_000,
  pdfPages: 100,
  pdfVisualPages: 10,
  pdfUsefulTextCharsPerPage: 32,
  pdfVisualPixels: 16_000_000,
  pdfPageDimension: 4_096,
  docxEntries: 2_048,
  docxExpandedBytes: 67_108_864,
  docxCompressionRatio: 100,
  csvRows: 50_000,
  csvColumns: 512,
  csvRecordChars: 32_768,
  imageDimension: 8_192,
  imagePixels: 40_000_000,
  workoutCandidates: 50,
  workoutSegments: 5_000,
  workoutDurationSeconds: 86_400,
  workoutDiagnostics: 100,
  workoutDiagnosticChars: 240,
  workoutTitleChars: 200,
  workoutPurposeChars: 500,
  parserMs: 30_000,
  parserOldGenerationMiB: 256,
  capabilityMetadataMaxAgeMs: 86_400_000,
  orphanGraceMs: 86_400_000,
});

export const DocumentAttachmentExtensionSchema = z.enum(["pdf", "txt", "csv", "docx"]);
export const ActivityAttachmentExtensionSchema = z.enum(["fit", "tcx", "gpx"]);
export const WorkoutAttachmentExtensionSchema = z.enum(["zwo", "mrc", "erg"]);
export const ImageAttachmentExtensionSchema = z.enum(["png", "jpg", "jpeg", "webp"]);
export const ChatAttachmentKindSchema = z.enum(["document", "activity", "workout", "image"]);

const AttachmentCapabilityBaseSchema = z
  .object({
    schemaVersion: z.literal(1),
    active: z
      .object({
        provider: z.string().min(1).max(128),
        model: z.string().min(1).max(256),
        transport: z.string().min(1).max(128),
      })
      .strict(),
    documents: z
      .object({
        enabled: z.literal(true),
        extensions: z.tuple([
          z.literal("pdf"),
          z.literal("txt"),
          z.literal("csv"),
          z.literal("docx"),
        ]),
      })
      .strict(),
    completedActivities: z
      .object({
        enabled: z.literal(true),
        extensions: z.tuple([z.literal("fit"), z.literal("tcx"), z.literal("gpx")]),
      })
      .strict(),
    plannedWorkouts: z
      .object({
        enabled: z.literal(true),
        extensions: z.tuple([z.literal("zwo"), z.literal("erg"), z.literal("mrc")]),
      })
      .strict(),
  })
  .strict();

const AttachmentCapabilityCheckedAtSchema = z.string().max(64).datetime({ offset: true });

export const AttachmentCapabilitiesReadModelSchema = z.union([
  AttachmentCapabilityBaseSchema.extend({
    images: z
      .object({
        enabled: z.literal(true),
        mediaTypes: z.tuple([
          z.literal("image/png"),
          z.literal("image/jpeg"),
          z.literal("image/webp"),
        ]),
        reason: z.literal("supported"),
        source: z.enum(["maintained_catalogue", "provider_metadata"]),
        checkedAt: AttachmentCapabilityCheckedAtSchema,
      })
      .strict(),
  }).strict(),
  AttachmentCapabilityBaseSchema.extend({
    images: z
      .object({
        enabled: z.literal(false),
        mediaTypes: z.tuple([]),
        reason: z.enum([
          "metadata_stale",
          "model_incompatible",
          "unknown_model",
          "transport_incompatible",
        ]),
        source: z.enum([
          "maintained_catalogue",
          "provider_metadata",
          "unknown",
          "transport_blocked",
        ]),
        checkedAt: AttachmentCapabilityCheckedAtSchema,
      })
      .strict(),
  }).strict(),
]);
export type AttachmentCapabilitiesReadModel = z.infer<typeof AttachmentCapabilitiesReadModelSchema>;

export const NativeChatAttachmentCandidateSchema = z
  .object({
    kind: z.literal("native-path"),
    sourcePath: PlatformAbsolutePathSchema,
  })
  .strict();
export type NativeChatAttachmentCandidate = z.infer<typeof NativeChatAttachmentCandidateSchema>;

export const AdmitChatAttachmentRequestSchema = z
  .object({
    chatId: z.string().min(1),
    selectionId: z.string().min(1),
    source: z.enum(["picker", "drop"]),
    candidate: NativeChatAttachmentCandidateSchema,
  })
  .strict();
export type AdmitChatAttachmentRequest = z.infer<typeof AdmitChatAttachmentRequestSchema>;

const AttachmentAdmissionBaseSchema = z
  .object({
    selectionId: z.string().min(1),
    displayName: z.string().min(1),
  })
  .strict();

export const AttachmentAdmissionReadModelSchema = z.discriminatedUnion("status", [
  AttachmentAdmissionBaseSchema.extend({ status: z.literal("selected") }).strict(),
  AttachmentAdmissionBaseSchema.extend({ status: z.literal("admitting") }).strict(),
  AttachmentAdmissionBaseSchema.extend({
    status: z.literal("rejected"),
    reason: z.enum([
      "empty_file",
      "file_too_large",
      "format_unsupported",
      "signature_mismatch",
      "unsafe_source",
      "validation_failed",
      "message_limit",
      "storage_full",
    ]),
  }).strict(),
  AttachmentAdmissionBaseSchema.extend({
    status: z.literal("storage_failed"),
    failureCode: z.enum(["admission_unavailable", "storage_failed"]),
    retryable: z.boolean(),
  }).strict(),
  AttachmentAdmissionBaseSchema.extend({
    status: z.literal("accepted"),
    attachmentId: z.string().min(1),
  }).strict(),
  AttachmentAdmissionBaseSchema.extend({ status: z.literal("removed") }).strict(),
]);
export type AttachmentAdmissionReadModel = z.infer<typeof AttachmentAdmissionReadModelSchema>;
