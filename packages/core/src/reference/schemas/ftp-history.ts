// Adapted from CrankAddict/section-11 (MIT, 2026); see NOTICE.md.

import { z } from "zod";

export const FTP_HISTORY_SCHEMA_VERSION = "1";

/**
 * `ftp_history.json` — sparse time-series of FTP test results plus eFTP
 * estimates from intervals.icu.
 */
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

export type FtpHistoryJson = z.infer<typeof FtpHistoryJsonSchema>;
