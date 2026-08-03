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
