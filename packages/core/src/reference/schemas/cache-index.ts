// Adapted from CrankAddict/section-11 (MIT, 2026); see NOTICE.md.
//
// Cache-schemas-only barrel — used by the strict-schemas regression test
// (tests/reference-strict-schemas.test.ts) which scopes to cache schemas
// only. Input schemas (inputs.ts) use z.looseObject() and are excluded.
//
// IMPORTANT: re-export directly from per-file sibling modules (./latest.js,
// ./history.js, etc.) — NOT from `./index.js`. Re-exporting from index.js
// would create a circular import (index.ts → cache-index.ts → index.ts).

export { LATEST_SCHEMA_VERSION, LatestJsonSchema, type LatestJson } from "./latest.js";
export { HISTORY_SCHEMA_VERSION, HistoryJsonSchema, type HistoryJson } from "./history.js";
export {
  INTERVALS_SCHEMA_VERSION,
  IntervalsJsonSchema,
  type IntervalsJson,
} from "./intervals.js";
export { ROUTES_SCHEMA_VERSION, RoutesJsonSchema, type RoutesJson } from "./routes.js";
export {
  FTP_HISTORY_SCHEMA_VERSION,
  FtpHistoryJsonSchema,
  type FtpHistoryJson,
} from "./ftp-history.js";
export {
  SCHEDULER_SCHEMA_VERSION,
  SchedulerStateSchema,
  type SchedulerState,
} from "./scheduler.js";
export {
  ERROR_STATE_SCHEMA_VERSION,
  ErrorStateSchema,
  type ErrorState,
  ErrorPhaseSchema,
  type ErrorPhase,
  ErrorCallerSchema,
  type ErrorCaller,
  ErrorMitigationSchema,
  type ErrorMitigation,
} from "./error-state.js";
