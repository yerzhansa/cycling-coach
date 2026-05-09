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
export const ErrorStateSchema = z
  .object({
    schema_version: z.string(),
    step: z.string(),
    detail: z.string(),
    ts: z.string(),
  })
  .strict();

export type ErrorState = z.infer<typeof ErrorStateSchema>;
