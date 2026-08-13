import { mkdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { parse as parseYaml, stringify as toYaml } from "yaml";
import { durableAtomicReplace } from "./durable-atomic-replace.js";
import { createSafeLog } from "./safe-log.js";
import {
  NO_SESSION_TIMEZONE_NOTICE,
  parseSessionTimezoneMode,
  SESSION_TIMEZONE_MODE_FILE_NAME,
  UNAVAILABLE_SESSION_TIMEZONE_SETTING,
  type DesktopSessionTimezoneNotice,
  type DesktopSessionTimezoneSetting,
  type SessionTimezoneMode,
} from "./session-timezone-contract.js";

export * from "./session-timezone-contract.js";

export const SESSION_TIMEZONE_MODE_DIRECTORY_MODE = 0o700;
export const SESSION_TIMEZONE_MODE_FILE_MODE = 0o600;
export const SESSION_CONFIG_FILE_MODE = 0o600;

const MAXIMUM_SESSION_TIMEZONE_MODE_FILE_BYTES = 256;
const MAXIMUM_SESSION_CONFIG_FILE_BYTES = 262144;

export type SessionTimezoneIdleReason =
  | "environment-managed"
  | "fixed"
  | "host-unavailable"
  | "already-following"
  | "stored-missing"
  | "stored-invalid"
  | "unanswered-and-equal";

export type SessionTimezoneStartDecision =
  | Readonly<{ kind: "idle"; reason: SessionTimezoneIdleReason }>
  | Readonly<{ kind: "adopt"; timezone: string }>
  | Readonly<{ kind: "reconcile"; stored: string; host: string }>;

export interface SessionTimezoneStartInput {
  readonly environmentManaged: boolean;
  readonly mode: SessionTimezoneMode | null;
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
  if (input.mode === "fixed") return { kind: "idle", reason: "fixed" };
  const stored = input.stored?.trim() ?? "";
  const host = input.host?.trim() ?? "";
  if (host.length === 0 || !isValidTimezone(host)) {
    return { kind: "idle", reason: "host-unavailable" };
  }
  if (input.mode === "follow") {
    return stored === host
      ? { kind: "idle", reason: "already-following" }
      : { kind: "adopt", timezone: host };
  }
  if (stored.length === 0) return { kind: "idle", reason: "stored-missing" };
  if (!isValidTimezone(stored)) return { kind: "idle", reason: "stored-invalid" };
  return stored === host
    ? { kind: "idle", reason: "unanswered-and-equal" }
    : { kind: "reconcile", stored, host };
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

function environmentTimezone(environment: Record<string, string | undefined>): string | undefined {
  return environment.COACH_TZ;
}

export function sessionTimezoneModePath(stateRoot: string): string {
  return join(stateRoot, SESSION_TIMEZONE_MODE_FILE_NAME);
}

export async function readSessionTimezoneMode(
  stateRoot: string,
): Promise<SessionTimezoneMode | undefined> {
  let contents: string;
  try {
    contents = await readFile(sessionTimezoneModePath(stateRoot), "utf8");
  } catch {
    return undefined;
  }
  if (contents.length > MAXIMUM_SESSION_TIMEZONE_MODE_FILE_BYTES) return undefined;
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
  return parseSessionTimezoneMode(parsed.mode);
}

async function writeSessionTimezoneMode(input: {
  readonly stateRoot: string;
  readonly mode: SessionTimezoneMode;
  readonly platform: NodeJS.Platform;
}): Promise<boolean> {
  try {
    await mkdir(input.stateRoot, {
      recursive: true,
      mode: SESSION_TIMEZONE_MODE_DIRECTORY_MODE,
    });
    const outcome = await durableAtomicReplace({
      root: input.stateRoot,
      fileName: SESSION_TIMEZONE_MODE_FILE_NAME,
      contents: `${JSON.stringify({ schemaVersion: 1, mode: input.mode })}\n`,
      mode: SESSION_TIMEZONE_MODE_FILE_MODE,
      platform: input.platform,
    });
    return outcome.state === "durably-committed";
  } catch {
    return false;
  }
}

export async function chooseSessionTimezoneMode(input: {
  readonly stateRoot: string;
  readonly mode: SessionTimezoneMode;
  readonly env?: Record<string, string | undefined>;
  readonly platform?: NodeJS.Platform;
}): Promise<boolean> {
  if (environmentTimezone(input.env ?? process.env) !== undefined) return false;
  return writeSessionTimezoneMode({
    stateRoot: input.stateRoot,
    mode: input.mode,
    platform: input.platform ?? process.platform,
  });
}

export async function recordFirstRunSessionTimezoneMode(input: {
  readonly stateRoot: string;
  readonly seeded: "seeded" | "existing";
  readonly env?: Record<string, string | undefined>;
  readonly platform?: NodeJS.Platform;
}): Promise<boolean> {
  if (input.seeded !== "seeded") return false;
  if (environmentTimezone(input.env ?? process.env) !== undefined) return false;
  if ((await readSessionTimezoneMode(input.stateRoot)) !== undefined) return false;
  return writeSessionTimezoneMode({
    stateRoot: input.stateRoot,
    mode: "follow",
    platform: input.platform ?? process.platform,
  });
}

export async function readSessionTimezoneSetting(input: {
  readonly stateRoot: string;
  readonly env?: Record<string, string | undefined>;
  readonly hostTimezone?: () => string | undefined;
}): Promise<DesktopSessionTimezoneSetting> {
  try {
    const managed = environmentTimezone(input.env ?? process.env);
    const rawHost = (input.hostTimezone ?? hostTimezoneFromRuntime)()?.trim() ?? "";
    const host = rawHost.length > 0 && isValidTimezone(rawHost) ? rawHost : null;
    if (managed !== undefined) {
      const configured = managed.trim();
      return {
        status: "environment-managed",
        timezone: configured.length > 0 ? configured : (host ?? "UTC"),
      };
    }
    const mode = await readSessionTimezoneMode(input.stateRoot);
    return { status: "editable", mode: mode ?? null, host };
  } catch {
    return UNAVAILABLE_SESSION_TIMEZONE_SETTING;
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
    if (environmentTimezone(environment) !== undefined) return NO_SESSION_TIMEZONE_NOTICE;
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
    const mode = await readSessionTimezoneMode(input.stateRoot);
    const decision = decideSessionTimezoneAtStart({
      environmentManaged: false,
      mode: mode ?? null,
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
