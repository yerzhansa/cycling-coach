import { z } from "zod";
import { ChatResponseSchema } from "./engine.js";

export const QueuedChatMessageSchema = z
  .object({
    queuedMessageId: z.string().min(1),
    submissionId: z.string().min(1),
    text: z.string().refine((value) => /\S/u.test(value)),
    kind: z.enum(["ordinary", "slash-command"]),
    position: z.number().int().nonnegative(),
    restored: z.boolean(),
  })
  .strict();
export type QueuedChatMessage = z.infer<typeof QueuedChatMessageSchema>;

export const ChatQueueRecoveryClaimSchema = z
  .object({
    claimId: z.string().min(1),
    queuedMessageIds: z.array(z.string().min(1)).min(1),
    turnId: z.string().min(1),
    status: z.literal("retry-required"),
  })
  .strict();
export type ChatQueueRecoveryClaim = z.infer<typeof ChatQueueRecoveryClaimSchema>;

export const ChatQueueSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: z.number().int().nonnegative(),
    items: z.array(QueuedChatMessageSchema),
    retryRequired: ChatQueueRecoveryClaimSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = new Set<string>();
    const submissions = new Set<string>();
    value.items.forEach((item, index) => {
      if (item.position !== index) {
        context.addIssue({
          code: "custom",
          path: ["items", index, "position"],
          message: "queue position must match FIFO order",
        });
      }
      if (ids.has(item.queuedMessageId)) {
        context.addIssue({
          code: "custom",
          path: ["items", index, "queuedMessageId"],
          message: "queued message ids must be unique",
        });
      }
      if (submissions.has(item.submissionId)) {
        context.addIssue({
          code: "custom",
          path: ["items", index, "submissionId"],
          message: "submission ids must be unique",
        });
      }
      ids.add(item.queuedMessageId);
      submissions.add(item.submissionId);
    });
    if (value.retryRequired !== undefined) {
      const expected = value.items
        .slice(0, value.retryRequired.queuedMessageIds.length)
        .map((item) => item.queuedMessageId);
      if (
        expected.length !== value.retryRequired.queuedMessageIds.length ||
        expected.some((id, index) => id !== value.retryRequired?.queuedMessageIds[index])
      ) {
        context.addIssue({
          code: "custom",
          path: ["retryRequired", "queuedMessageIds"],
          message: "retry claim must own an exact queue-head prefix",
        });
      }
    }
  });
export type ChatQueueSnapshot = z.infer<typeof ChatQueueSnapshotSchema>;

export const EnqueueChatMessageRequestSchema = z
  .object({
    chatId: z.string().min(1),
    submissionId: z.string().min(1),
    text: z.string().refine((value) => /\S/u.test(value)),
  })
  .strict();
export type EnqueueChatMessageRequest = z.infer<typeof EnqueueChatMessageRequestSchema>;

export const GetChatQueueRequestSchema = z.object({ chatId: z.string().min(1) }).strict();
export type GetChatQueueRequest = z.infer<typeof GetChatQueueRequestSchema>;

export const RemoveQueuedChatMessageRequestSchema = z
  .object({ chatId: z.string().min(1), queuedMessageId: z.string().min(1) })
  .strict();
export type RemoveQueuedChatMessageRequest = z.infer<typeof RemoveQueuedChatMessageRequestSchema>;

export const ResumeChatQueueRequestSchema = GetChatQueueRequestSchema;
export type ResumeChatQueueRequest = z.infer<typeof ResumeChatQueueRequestSchema>;

export const RunQueuedCommandRequestSchema = z
  .object({ chatId: z.string().min(1), queuedMessageId: z.string().min(1) })
  .strict();
export type RunQueuedCommandRequest = z.infer<typeof RunQueuedCommandRequestSchema>;

export const RetryQueuedTurnRequestSchema = z
  .object({ chatId: z.string().min(1), claimId: z.string().min(1) })
  .strict();
export type RetryQueuedTurnRequest = z.infer<typeof RetryQueuedTurnRequestSchema>;

export const ChatQueueRunResultSchema = z
  .object({ snapshot: ChatQueueSnapshotSchema, response: ChatResponseSchema.optional() })
  .strict();
export type ChatQueueRunResult = z.infer<typeof ChatQueueRunResultSchema>;
