// Adapted from CrankAddict/section-11 (MIT, 2026); see NOTICE.md.

import { z } from "zod";

export const ERROR_STATE_SCHEMA_VERSION = "1";

/**
 * `error_state.json` — when the Layer-1 sync gate rejects a fresh sync
 * (e.g., intervals.icu schema drift), it writes this file. The curator
 * reads it at turn start to decide whether to inject an "I cannot validate
 * the latest data" block in the system prompt. Cleared on the next
 * successful sync.
 */
/**
 * `phase` is set by `runSync()` when the outer 2-min timeout fires, so the
 * Wave 4 / Wave 5 readers can tell whether cache files made it to disk.
 * Other failure modes (Layer-1 gate reject, etc.) omit it.
 */
export const ErrorPhaseSchema = z.enum([
  "fetching",
  "gating",
  "writing_cache",
  "writing_scheduler",
]);

export type ErrorPhase = z.infer<typeof ErrorPhaseSchema>;

export const ErrorStateSchema = z
  .object({
    schema_version: z.string(),
    step: z.string(),
    detail: z.string(),
    ts: z.string(),
    phase: ErrorPhaseSchema.optional(),
  })
  .strict();

export type ErrorState = z.infer<typeof ErrorStateSchema>;
