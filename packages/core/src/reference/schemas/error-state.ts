import { z } from "zod";

export const ERROR_STATE_SCHEMA_VERSION = "1";

/**
 * Single source of truth for sync-caller vocabulary, shared between
 * `run-sync.ts`'s `SyncCaller` type and on-disk `error_state.json`'s
 * `caller` field. Adding a caller (e.g., a future `"operator"`) here
 * updates the runtime opt and the schema in lockstep.
 */
export const SYNC_CALLERS = ["scheduled", "lazy", "/sync"] as const;

/**
 * `error_state.json` — when the Layer-1 sync gate rejects a fresh sync
 * (e.g., intervals.icu schema drift), it writes this file. The curator
 * reads it at turn start to decide whether to inject an "I cannot validate
 * the latest data" block in the system prompt. Cleared on the next
 * successful sync.
 */
/**
 * `phase` is set by `runSync()` when the outer 2-min timeout fires, so
 * downstream readers (sync gate, curator) can tell whether cache files
 * made it to disk. Other failure modes (Layer-1 gate reject, etc.) omit it.
 */
export const ErrorPhaseSchema = z.enum([
  "fetching",
  "gating",
  "writing_cache",
  "writing_scheduler",
]);

export type ErrorPhase = z.infer<typeof ErrorPhaseSchema>;

/**
 * The sync gate populates `mitigation` so the curator can choose:
 * force-resync (transient), block-coaching (data corruption that could
 * mislead the athlete), or warn-only (non-blocking inconsistency). The
 * schema is declared here ahead of the gate body so on-disk format doesn't
 * need a version bump when the gate begins writing the field.
 */
export const ErrorMitigationSchema = z.enum([
  "force_resync",
  "block_coaching",
  "warn_only",
]);

export type ErrorMitigation = z.infer<typeof ErrorMitigationSchema>;

/**
 * `caller` records which orchestrator entry-point triggered the failure —
 * the curator uses it to decide whether to surface the failure to the
 * athlete (a `/sync` failure goes to the athlete; a scheduled failure stays
 * internal until the staleness band crosses a threshold).
 *
 * Derived from `SYNC_CALLERS` (this file) so the on-disk schema cannot
 * drift from the runtime opt's `SyncCaller` type, which `run-sync.ts`
 * re-derives from `ErrorCaller`.
 */
export const ErrorCallerSchema = z.enum(SYNC_CALLERS);

export type ErrorCaller = z.infer<typeof ErrorCallerSchema>;

export const ErrorStateSchema = z
  .object({
    schema_version: z.string(),
    step: z.string(),
    detail: z.string(),
    ts: z.string(),
    phase: ErrorPhaseSchema.optional(),
    caller: ErrorCallerSchema.optional(),
    /** e.g., "ftp_source_check". */
    gate_check: z.string().optional(),
    /** Any JSON-serializable value; gate-check writers should keep these small for log readability. */
    expected: z.unknown().optional(),
    /** Any JSON-serializable value; gate-check writers should keep these small for log readability. */
    observed: z.unknown().optional(),
    mitigation: ErrorMitigationSchema.optional(),
  })
  .strict();

export type ErrorState = z.infer<typeof ErrorStateSchema>;
