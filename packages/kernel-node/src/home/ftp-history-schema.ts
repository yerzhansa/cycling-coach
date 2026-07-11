import { z } from "zod";

export const FTP_HISTORY_SCHEMA_VERSION = "1";

export const FtpHistoryJsonSchema = z
  .object({
    metadata: z
      .object({
        schema_version: z.string(),
        last_updated: z.string(),
      })
      .strict(),
    entries: z.array(z.unknown()),
  })
  .strict();

export const FtpHistoryPointSchema = z.looseObject({
  date: z.string(),
  ftp: z.number().int().positive(),
  source: z.enum(["test", "estimate"]),
});

export type FtpHistoryJson = z.infer<typeof FtpHistoryJsonSchema>;
export type FtpHistoryPoint = z.infer<typeof FtpHistoryPointSchema>;
