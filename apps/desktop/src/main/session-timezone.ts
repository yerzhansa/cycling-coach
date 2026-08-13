import { mkdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { parse as parseYaml, stringify as toYaml } from "yaml";
import { durableAtomicReplace } from "./durable-atomic-replace.js";
import { createSafeLog } from "./safe-log.js";
import {
  NO_SESSION_TIMEZONE_NOTICE,
  parseSessionTimezoneSource,
  SESSION_TIMEZONE_SOURCE_FILE_NAME,
  type DesktopSessionTimezoneNotice,
  type SessionTimezoneSource,
} from "./session-timezone-contract.js";

export * from "./session-timezone-contract.js";

export const SESSION_TIMEZONE_SOURCE_DIRECTORY_MODE = 0o700;
export const SESSION_TIMEZONE_SOURCE_FILE_MODE = 0o600;
export const SESSION_CONFIG_FILE_MODE = 0o600;

const MAXIMUM_SESSION_TIMEZONE_SOURCE_FILE_BYTES = 256;
const MAXIMUM_SESSION_CONFIG_FILE_BYTES = 262144;

export type SessionTimezoneIdleReason =
  | "environment-managed"
  | "host-unavailable"
  | "stored-missing"
  | "stored-invalid"
  | "unchanged"
  | "user-set";

export type SessionTimezoneStartDecision =
  | Readonly<{ kind: "idle"; reason: SessionTimezoneIdleReason }>
  | Readonly<{ kind: "adopt"; timezone: string }>
  | Readonly<{ kind: "reconcile"; stored: string; host: string }>;

export interface SessionTimezoneStartInput {
  readonly environmentManaged: boolean;
  readonly source?: SessionTimezoneSource;
  readonly stored?: string;
  readonly host?: string;
}

export function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function decideSessionTimezoneAtStart(
  input: SessionTimezoneStartInput,
): SessionTimezoneStartDecision {
  if (input.environmentManaged) return { kind: "idle", reason: "environment-managed" };
  if (input.source === "user") return { kind: "idle", reason: "user-set" };
  const stored = input.stored?.trim() ?? "";
  if (stored.length === 0) return { kind: "idle", reason: "stored-missing" };
  if (!isValidTimezone(stored)) return { kind: "idle", reason: "stored-invalid" };
  const host = input.host?.trim() ?? "";
  if (host.length === 0 || !isValidTimezone(host)) {
    return { kind: "idle", reason: "host-unavailable" };
  }
  if (stored === host) return { kind: "idle", reason: "unchanged" };
  if (input.source === "auto") return { kind: "adopt", timezone: host };
  return { kind: "reconcile", stored, host };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hostTimezoneFromRuntime(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

export function sessionTimezoneSourcePath(stateRoot: string): string {
  return join(stateRoot, SESSION_TIMEZONE_SOURCE_FILE_NAME);
}

export async function readSessionTimezoneSource(
  stateRoot: string,
): Promise<SessionTimezoneSource | undefined> {
  let contents: string;
  try {
    contents = await readFile(sessionTimezoneSourcePath(stateRoot), "utf8");
  } catch {
    return undefined;
  }
  if (contents.length > MAXIMUM_SESSION_TIMEZONE_SOURCE_FILE_BYTES) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  if (!Number.isSafeInteger(parsed.schemaVersion) || (parsed.schemaVersion as number) < 1) {
    return undefined;
  }
  return parseSessionTimezoneSource(parsed.source);
}

export async function recordSessionTimezoneSource(input: {
  readonly stateRoot: string;
  readonly source: SessionTimezoneSource;
  readonly platform?: NodeJS.Platform;
}): Promise<boolean> {
  const platform = input.platform ?? process.platform;
  try {
    await mkdir(input.stateRoot, {
      recursive: true,
      mode: SESSION_TIMEZONE_SOURCE_DIRECTORY_MODE,
    });
    const outcome = await durableAtomicReplace({
      root: input.stateRoot,
      fileName: SESSION_TIMEZONE_SOURCE_FILE_NAME,
      contents: `${JSON.stringify({ schemaVersion: 1, source: input.source })}\n`,
      mode: SESSION_TIMEZONE_SOURCE_FILE_MODE,
      platform,
    });
    return outcome.state === "durably-committed";
  } catch {
    return false;
  }
}

function storedSessionTimezone(document: unknown): string | undefined {
  if (!isRecord(document) || !isRecord(document.session)) return undefined;
  const timezone = document.session.timezone;
  return typeof timezone === "string" ? timezone : undefined;
}

function withSessionTimezone(document: Record<string, unknown>, timezone: string): string {
  const session = isRecord(document.session) ? { ...document.session } : {};
  session.timezone = timezone;
  return toYaml({ ...document, session });
}

export interface ReconcileSessionTimezoneInput {
  readonly configPath: string;
  readonly stateRoot: string;
  readonly env?: Record<string, string | undefined>;
  readonly platform?: NodeJS.Platform;
  readonly hostTimezone?: () => string | undefined;
  readonly log?: (message: string) => void;
}

export async function reconcileSessionTimezoneAtStart(
  input: ReconcileSessionTimezoneInput,
): Promise<DesktopSessionTimezoneNotice> {
  const platform = input.platform ?? process.platform;
  const environment = input.env ?? process.env;
  const log = createSafeLog(input.log);
  try {
    if (environment.COACH_TZ !== undefined) return NO_SESSION_TIMEZONE_NOTICE;
    let contents: string;
    try {
      contents = await readFile(input.configPath, "utf8");
    } catch {
      return NO_SESSION_TIMEZONE_NOTICE;
    }
    if (contents.length > MAXIMUM_SESSION_CONFIG_FILE_BYTES) return NO_SESSION_TIMEZONE_NOTICE;
    let document: unknown;
    try {
      document = parseYaml(contents);
    } catch {
      return NO_SESSION_TIMEZONE_NOTICE;
    }
    if (!isRecord(document)) return NO_SESSION_TIMEZONE_NOTICE;
    const source = await readSessionTimezoneSource(input.stateRoot);
    const decision = decideSessionTimezoneAtStart({
      environmentManaged: false,
      ...(source === undefined ? {} : { source }),
      stored: storedSessionTimezone(document),
      host: (input.hostTimezone ?? hostTimezoneFromRuntime)(),
    });
    if (decision.kind === "idle") return NO_SESSION_TIMEZONE_NOTICE;
    if (decision.kind === "reconcile") {
      return { status: "reconcile", stored: decision.stored, host: decision.host };
    }
    const outcome = await durableAtomicReplace({
      root: dirname(input.configPath),
      fileName: basename(input.configPath),
      contents: withSessionTimezone(document, decision.timezone),
      mode: SESSION_CONFIG_FILE_MODE,
      platform,
    });
    if (outcome.state === "durably-committed") log("desktop-session-timezone-adopted");
    return NO_SESSION_TIMEZONE_NOTICE;
  } catch {
    return NO_SESSION_TIMEZONE_NOTICE;
  }
}
