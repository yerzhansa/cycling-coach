// Adapted from CrankAddict/section-11 (MIT, 2026); see NOTICE.md.

import { z } from "zod";

export const SCHEDULER_SCHEMA_VERSION = "1";

/**
 * `.scheduler.json` — durable coordination state for the sync loop.
 * `last_sync_at` and `next_sync_at` are ISO 8601 strings; both nullable so
 * the cold-start case (never synced) round-trips cleanly. Atomic-write on
 * update; safe-read on startup with discard-and-resync on parse failure
 * (per Reference PRD Decision 9).
 */
export const SchedulerStateSchema = z
  .object({
    schema_version: z.string(),
    last_sync_at: z.string().nullable(),
    next_sync_at: z.string().nullable(),
  })
  .strict();

export type SchedulerState = z.infer<typeof SchedulerStateSchema>;
