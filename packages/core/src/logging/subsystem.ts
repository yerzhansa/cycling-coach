import { type LogLevel } from "./levels.js";
import { createRootLogger, type RootLogger, type RootLoggerOptions } from "./logger.js";
import { serializeError } from "./serialize-error.js";

type Fields = Record<string, unknown>;

export interface SubsystemLogger {
  debug(event: string, fields?: Fields): void;
  info(event: string, fields?: Fields): void;
  warn(event: string, err?: unknown, fields?: Fields): void;
  error(event: string, err?: unknown, fields?: Fields): void;
}

const SUBSYSTEMS = ["sync", "telegram", "agent", "compaction", "memory", "audit"] as const;

export type Subsystem = (typeof SUBSYSTEMS)[number];

function emitErrBearing(
  root: RootLogger,
  level: LogLevel,
  component: string,
  event: string,
  err?: unknown,
  fields?: Fields,
): void {
  const errFields = err === undefined ? {} : { err: serializeError(err) };
  root.emit(level, { component, event, ...errFields, ...fields });
}

export function createSubsystemLogger(
  component: string,
  dataDir: string,
  options?: RootLoggerOptions,
): SubsystemLogger {
  const root = createRootLogger(dataDir, options);
  return {
    debug(event, fields) {
      root.emit("debug", { component, event, ...fields });
    },
    info(event, fields) {
      root.emit("info", { component, event, ...fields });
    },
    warn(event, err, fields) {
      emitErrBearing(root, "warn", component, event, err, fields);
    },
    error(event, err, fields) {
      emitErrBearing(root, "error", component, event, err, fields);
    },
  };
}

// The launch set of subsystem child loggers. More tags can be added cheaply by
// calling createSubsystemLogger directly; these are the components the batch's
// consumers tag against.
export function createSubsystemLoggers(
  dataDir: string,
  options?: RootLoggerOptions,
): Record<Subsystem, SubsystemLogger> {
  const out = {} as Record<Subsystem, SubsystemLogger>;
  for (const name of SUBSYSTEMS) {
    out[name] = createSubsystemLogger(name, dataDir, options);
  }
  return out;
}
