// Adapted from CrankAddict/section-11 (MIT, 2026); see NOTICE.md.

import { z } from "zod";

export const INTERVALS_SCHEMA_VERSION = "1";

/** `intervals.json` — per-rep workout segments for the recent activity window. */
export const IntervalsJsonSchema = z
  .object({
    metadata: z
      .object({
        schema_version: z.string(),
        last_updated: z.string(),
      })
      .strict(),
    by_activity: z.record(z.string(), z.array(z.unknown())),
  })
  .strict();

export type IntervalsJson = z.infer<typeof IntervalsJsonSchema>;
