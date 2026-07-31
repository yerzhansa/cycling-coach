import { z } from "zod";

export const HISTORY_SCHEMA_VERSION = "1";

/**
 * `history.json` — long-window training history at three resolutions
 * (daily 90 d, weekly 180 d, monthly 3 y).
 */
export const HistoryJsonSchema = z
  .object({
    metadata: z
      .object({
        schema_version: z.string(),
        last_updated: z.string(),
      })
      .strict(),
    daily: z.array(z.unknown()),
    weekly: z.array(z.unknown()),
    monthly: z.array(z.unknown()),
  })
  .strict();

export type HistoryJson = z.infer<typeof HistoryJsonSchema>;
