// Adapted from CrankAddict/section-11 (MIT, 2026); see NOTICE.md.

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
} from "./error-state.js";
