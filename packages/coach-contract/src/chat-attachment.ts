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

export const ChatAttachmentExtensionSchema = z.union([
  DocumentAttachmentExtensionSchema,
  ActivityAttachmentExtensionSchema,
  WorkoutAttachmentExtensionSchema,
  ImageAttachmentExtensionSchema,
]);
export type ChatAttachmentExtension = z.infer<typeof ChatAttachmentExtensionSchema>;

const ChatAttachmentComposerBaseSchema = z
  .object({
    schemaVersion: z.literal(1),
    attachmentId: z.string().min(1).max(128),
    displayName: z.string().min(1).max(512),
    kind: ChatAttachmentKindSchema,
    extension: ChatAttachmentExtensionSchema,
    byteSize: z.number().int().positive().max(CHAT_ATTACHMENT_LIMITS.activityBytes),
  })
  .strict();

export const ChatAttachmentActivityPreviewSchema = z
  .object({
    sourceFormat: ActivityAttachmentExtensionSchema,
    sessions: z
      .array(
        z
          .object({
            sport: z.string().min(1).max(64),
            startUtc: z.number().int().nonnegative(),
            durationSeconds: z.number().finite().nonnegative(),
            distanceMeters: z.number().finite().nonnegative().nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(256),
  })
  .strict();
export type ChatAttachmentActivityPreview = z.infer<typeof ChatAttachmentActivityPreviewSchema>;

export const ChatAttachmentWorkoutCandidateSchema = z
  .object({
    workoutId: z.string().min(1).max(128),
    title: z.string().min(1).max(CHAT_ATTACHMENT_LIMITS.workoutTitleChars),
    durationSeconds: z.number().int().positive().max(CHAT_ATTACHMENT_LIMITS.workoutDurationSeconds),
    target: z.string().min(1).max(160),
    purpose: z.string().min(1).max(CHAT_ATTACHMENT_LIMITS.workoutPurposeChars).nullable(),
  })
  .strict();
export type ChatAttachmentWorkoutCandidate = z.infer<typeof ChatAttachmentWorkoutCandidateSchema>;

export const ChatAttachmentComposerItemSchema = z.discriminatedUnion("status", [
  ChatAttachmentComposerBaseSchema.extend({ status: z.literal("preprocessing") }).strict(),
  ChatAttachmentComposerBaseSchema.extend({
    status: z.literal("blocked"),
    reason: z.enum([
      "encrypted_pdf",
      "metadata_stale",
      "model_incompatible",
      "validation_failed",
      "visual_pdf_unsupported",
    ]),
  }).strict(),
  ChatAttachmentComposerBaseSchema.extend({
    status: z.literal("failed"),
    stage: z.enum(["storage", "parsing", "import"]),
    failureCode: z.string().min(1).max(128),
    retryable: z.boolean(),
  }).strict(),
  ChatAttachmentComposerBaseSchema.extend({
    status: z.literal("ready"),
    preview: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("document"),
          extractedTextChars: z
            .number()
            .int()
            .nonnegative()
            .max(CHAT_ATTACHMENT_LIMITS.extractedTextChars),
          visualPageCount: z
            .number()
            .int()
            .nonnegative()
            .max(CHAT_ATTACHMENT_LIMITS.pdfVisualPages),
        })
        .strict(),
      ChatAttachmentActivityPreviewSchema.extend({ kind: z.literal("activity") }).strict(),
      z
        .object({
          kind: z.literal("workout"),
          sourceFormat: WorkoutAttachmentExtensionSchema,
          selectedWorkoutId: z.string().min(1).max(128).nullable(),
          workouts: z
            .array(ChatAttachmentWorkoutCandidateSchema)
            .min(1)
            .max(CHAT_ATTACHMENT_LIMITS.workoutCandidates),
        })
        .strict()
        .superRefine((value, context) => {
          if (
            value.selectedWorkoutId !== null &&
            !value.workouts.some((workout) => workout.workoutId === value.selectedWorkoutId)
          ) {
            context.addIssue({
              code: "custom",
              path: ["selectedWorkoutId"],
              message: "selected workout must exist",
            });
          }
        }),
      z
        .object({
          kind: z.literal("image"),
          mediaType: z.enum(["image/png", "image/jpeg", "image/webp"]),
          width: z.number().int().positive().max(CHAT_ATTACHMENT_LIMITS.imageDimension),
          height: z.number().int().positive().max(CHAT_ATTACHMENT_LIMITS.imageDimension),
        })
        .strict(),
    ]),
  }).strict(),
]);
export type ChatAttachmentComposerItem = z.infer<typeof ChatAttachmentComposerItemSchema>;

export const ChatAttachmentDraftReadModelSchema = z
  .object({
    schemaVersion: z.literal(1),
    chatId: z.string().min(1).max(512),
    text: z.string(),
    state: z.enum(["active", "restored", "submitting", "clearing"]),
    updatedAt: z.string().datetime({ offset: true }),
    attachments: z
      .array(ChatAttachmentComposerItemSchema)
      .max(CHAT_ATTACHMENT_LIMITS.attachmentsPerMessage),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.text.length === 0 && value.attachments.length === 0) {
      context.addIssue({ code: "custom", message: "attachment draft cannot be empty" });
    }
    const ids = value.attachments.map((attachment) => attachment.attachmentId);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        path: ["attachments"],
        message: "attachment ids must be unique",
      });
    }
  });
export type ChatAttachmentDraftReadModel = z.infer<typeof ChatAttachmentDraftReadModelSchema>;

export const ChatAttachmentComposerReadModelSchema = z
  .object({
    schemaVersion: z.literal(1),
    capabilities: AttachmentCapabilitiesReadModelSchema,
    draft: ChatAttachmentDraftReadModelSchema.nullable(),
  })
  .strict();
export type ChatAttachmentComposerReadModel = z.infer<typeof ChatAttachmentComposerReadModelSchema>;

export const GetChatAttachmentComposerRequestSchema = z
  .object({ chatId: z.string().min(1).max(512) })
  .strict();
export type GetChatAttachmentComposerRequest = z.infer<
  typeof GetChatAttachmentComposerRequestSchema
>;

export const SaveChatAttachmentDraftTextRequestSchema = z
  .object({
    chatId: z.string().min(1).max(512),
    text: z.string(),
  })
  .strict();
export type SaveChatAttachmentDraftTextRequest = z.infer<
  typeof SaveChatAttachmentDraftTextRequestSchema
>;

export const ChatAttachmentMutationRequestSchema = z
  .object({
    chatId: z.string().min(1).max(512),
    attachmentId: z.string().min(1).max(128),
  })
  .strict();
export type ChatAttachmentMutationRequest = z.infer<typeof ChatAttachmentMutationRequestSchema>;

export const SelectChatAttachmentWorkoutRequestSchema = ChatAttachmentMutationRequestSchema.extend({
  workoutId: z.string().min(1).max(128),
}).strict();
export type SelectChatAttachmentWorkoutRequest = z.infer<
  typeof SelectChatAttachmentWorkoutRequestSchema
>;

export const ClearChatAttachmentDraftRequestSchema = GetChatAttachmentComposerRequestSchema;
export type ClearChatAttachmentDraftRequest = z.infer<typeof ClearChatAttachmentDraftRequestSchema>;

export const AdmitPastedChatAttachmentRequestSchema = z
  .object({
    chatId: z.string().min(1).max(512),
    selectionId: z.string().min(1).max(128),
    displayName: z.string().min(1).max(512),
    dataBase64: z.string().min(1).max(30_000_000),
  })
  .strict();
export type AdmitPastedChatAttachmentRequest = z.infer<
  typeof AdmitPastedChatAttachmentRequestSchema
>;
