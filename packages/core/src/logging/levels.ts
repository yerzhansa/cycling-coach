export const LOG_LEVELS = ["silent", "error", "warn", "info", "debug"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_ORDER: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

export function normalizeLogLevel(s?: string): LogLevel {
  const candidate = (s ?? "").trim().toLowerCase();
  return (LOG_LEVELS as readonly string[]).includes(candidate)
    ? (candidate as LogLevel)
    : "info";
}

export function logLevelRank(level: LogLevel): number {
  return LEVEL_ORDER[level];
}

// A line at `lineLevel` is emitted when the configured threshold is at least as
// verbose. `silent` emits nothing; `debug` lets everything through.
export function isLevelEnabled(lineLevel: LogLevel, threshold: LogLevel): boolean {
  if (threshold === "silent") return false;
  return LEVEL_ORDER[lineLevel] <= LEVEL_ORDER[threshold];
}
