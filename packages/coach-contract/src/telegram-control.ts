import { z } from "zod";

export const TelegramCredentialSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      value === value.trim() &&
      Array.from(value).every((character) => {
        const codePoint = character.codePointAt(0)!;
        return codePoint > 0x20 && codePoint !== 0x7f;
      }),
    { message: "invalid Telegram credential" },
  );
export type TelegramCredential = z.infer<typeof TelegramCredentialSchema>;

export const ConfigureTelegramRpcParamsSchema = z
  .object({ token: TelegramCredentialSchema })
  .strict();
export type ConfigureTelegramRpcParams = z.infer<typeof ConfigureTelegramRpcParamsSchema>;

export const ReplaceTelegramRpcParamsSchema = z
  .object({ token: TelegramCredentialSchema })
  .strict();
export type ReplaceTelegramRpcParams = z.infer<typeof ReplaceTelegramRpcParamsSchema>;

export const TelegramChannelStatusSchema = z.discriminatedUnion("state", [
  z.object({ desiredState: z.literal("disabled"), state: z.literal("disabled") }).strict(),
  z
    .object({
      desiredState: z.literal("enabled"),
      state: z.literal("waiting-for-credential"),
    })
    .strict(),
  z.object({ desiredState: z.literal("enabled"), state: z.literal("starting") }).strict(),
  z.object({ desiredState: z.literal("enabled"), state: z.literal("online") }).strict(),
  z
    .object({
      desiredState: z.literal("enabled"),
      errorCode: z.literal("telegram-invalid-token"),
      state: z.literal("invalid-token"),
    })
    .strict(),
  z
    .object({
      desiredState: z.literal("enabled"),
      errorCode: z.literal("telegram-polling-conflict"),
      state: z.literal("conflict"),
    })
    .strict(),
  z
    .object({
      desiredState: z.literal("enabled"),
      errorCode: z.literal("telegram-start-failed"),
      state: z.literal("failed"),
    })
    .strict(),
]);
export type TelegramChannelStatus = z.infer<typeof TelegramChannelStatusSchema>;

export const TelegramBotUsernameSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{4,31}$/);
export type TelegramBotUsername = z.infer<typeof TelegramBotUsernameSchema>;

export const TelegramCanonicalTimestampSchema = z
  .string()
  .max(40)
  .refine((value) => {
    try {
      return new Date(value).toISOString() === value;
    } catch {
      return false;
    }
  }, "invalid canonical timestamp");

export const TelegramCredentialInspectionSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("ready"),
      bot: z.object({ username: TelegramBotUsernameSchema }).strict(),
    })
    .strict(),
  z
    .object({
      status: z.literal("webhook-removal-required"),
      bot: z.object({ username: TelegramBotUsernameSchema }).strict(),
    })
    .strict(),
  z.object({ status: z.literal("invalid-token") }).strict(),
  z
    .object({
      status: z.literal("unavailable"),
      errorCode: z.literal("telegram-validation-failed"),
    })
    .strict(),
]);
export type TelegramCredentialInspection = z.infer<typeof TelegramCredentialInspectionSchema>;

export const TelegramBotStateSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("unconfigured") }).strict(),
  z.object({ state: z.literal("ready"), username: TelegramBotUsernameSchema }).strict(),
  z
    .object({
      state: z.literal("webhook-removal-required"),
      username: TelegramBotUsernameSchema,
    })
    .strict(),
]);
export type TelegramBotState = z.infer<typeof TelegramBotStateSchema>;

export const TelegramPairingStateSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("unpaired") }).strict(),
  z
    .object({
      state: z.literal("awaiting-code"),
      code: z.string().regex(/^[A-F0-9]{6}$/),
      expiresAt: TelegramCanonicalTimestampSchema,
    })
    .strict(),
  z.object({ state: z.literal("paired") }).strict(),
  z.object({ state: z.literal("expired") }).strict(),
  z
    .object({
      state: z.literal("failed"),
      errorCode: z.enum([
        "telegram-pairing-unavailable",
        "telegram-pairing-refused",
        "telegram-pairing-storage-failed",
      ]),
    })
    .strict(),
]);
export type TelegramPairingState = z.infer<typeof TelegramPairingStateSchema>;

export const TelegramControlSnapshotSchema = z
  .object({
    channel: TelegramChannelStatusSchema,
    bot: TelegramBotStateSchema,
    pairing: TelegramPairingStateSchema,
  })
  .strict();
export type TelegramControlSnapshot = z.infer<typeof TelegramControlSnapshotSchema>;

export const InspectTelegramCredentialRpcParamsSchema = ConfigureTelegramRpcParamsSchema;
export type InspectTelegramCredentialRpcParams = ConfigureTelegramRpcParams;

export const DeleteTelegramWebhookRpcParamsSchema = ConfigureTelegramRpcParamsSchema;
export type DeleteTelegramWebhookRpcParams = ConfigureTelegramRpcParams;

export const TelegramSenderIdSchema = z.number().int().min(10).max(Number.MAX_SAFE_INTEGER);
export type TelegramSenderId = z.infer<typeof TelegramSenderIdSchema>;

export const TelegramAllowedSenderSchema = z
  .object({
    senderId: TelegramSenderIdSchema,
    role: z.enum(["primary", "additional"]),
    addedAt: TelegramCanonicalTimestampSchema.optional(),
  })
  .strict();
export type TelegramAllowedSender = z.infer<typeof TelegramAllowedSenderSchema>;

export const TelegramAllowedSendersResultSchema = z
  .object({ senders: z.array(TelegramAllowedSenderSchema).max(1_000) })
  .strict()
  .superRefine((value, context) => {
    const ids = new Set(value.senders.map((sender) => sender.senderId));
    if (ids.size !== value.senders.length) {
      context.addIssue({ code: "custom", path: ["senders"], message: "duplicate sender id" });
    }
    const primaryCount = value.senders.filter((sender) => sender.role === "primary").length;
    if (primaryCount !== (value.senders.length === 0 ? 0 : 1)) {
      context.addIssue({ code: "custom", path: ["senders"], message: "invalid primary sender" });
    }
  });
export type TelegramAllowedSendersResult = z.infer<typeof TelegramAllowedSendersResultSchema>;

export const TelegramAllowedSenderRpcParamsSchema = z
  .object({ senderId: TelegramSenderIdSchema })
  .strict();
export type TelegramAllowedSenderRpcParams = z.infer<typeof TelegramAllowedSenderRpcParamsSchema>;
