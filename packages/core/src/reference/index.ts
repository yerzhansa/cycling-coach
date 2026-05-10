// Adapted from CrankAddict/section-11 (MIT, 2026); see NOTICE.md.
//
// Reference submodule public barrel. Wired into `packages/core/src/index.ts`
// at the package boundary. Wave 1 lands the type-only + I/O + schema surface;
// Waves 2-7 extend incrementally.

// ─── Per-sport seam type (ADR-0010) ───────────────────────────────────
export type {
  DfaSummary,
  PowerCurveDelta,
  ReferenceSportAdapter,
} from "./sport-adapter.js";

// ─── Service-aggregate type for downstream channels ───────────────────
export type { ReferenceServices } from "./services.js";

// ─── Constants ────────────────────────────────────────────────────────
export {
  FRESH_MS,
  STALE_MS,
  CRITICAL_MS,
  LATEST_RETENTION_DAYS,
  HISTORY_DAILY_DAYS,
  HISTORY_WEEKLY_DAYS,
  HISTORY_MONTHLY_YEARS,
  INTERVALS_RETENTION_DAYS,
  ROUTES_RETENTION_DAYS,
  MUTEX_ACQUIRE_TIMEOUT_MS,
  SYNC_OPERATION_TIMEOUT_MS,
  SYNC_COOLDOWN_MS,
  MUTEX_HOT_WARN_MS,
  SCHEDULED_SYNC_INTERVAL_MS,
} from "./freshness.js";

// ─── Path resolution ──────────────────────────────────────────────────
export { referenceDataDir } from "./paths.js";

// ─── Compaction tokens (Wave 5 / F21 fills) ───────────────────────────
export { REFERENCE_PRESERVE_TOKENS } from "./preserve-tokens.js";

// ─── I/O helpers ──────────────────────────────────────────────────────
export { atomicWriteJson } from "./io/atomic-write.js";
export { safeReadJson } from "./io/safe-read.js";

// ─── Zod schemas + per-file SCHEMA_VERSION constants ──────────────────
export {
  LATEST_SCHEMA_VERSION,
  LatestJsonSchema,
  type LatestJson,
  HISTORY_SCHEMA_VERSION,
  HistoryJsonSchema,
  type HistoryJson,
  INTERVALS_SCHEMA_VERSION,
  IntervalsJsonSchema,
  type IntervalsJson,
  ROUTES_SCHEMA_VERSION,
  RoutesJsonSchema,
  type RoutesJson,
  FTP_HISTORY_SCHEMA_VERSION,
  FtpHistoryJsonSchema,
  type FtpHistoryJson,
  SCHEDULER_SCHEMA_VERSION,
  SchedulerStateSchema,
  type SchedulerState,
  ERROR_STATE_SCHEMA_VERSION,
  ErrorStateSchema,
  type ErrorState,
} from "./schemas/index.js";
