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
