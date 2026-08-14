import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { parse as parseYaml, stringify as toYaml } from "yaml";
import { durableAtomicReplace } from "./durable-atomic-replace.js";
import { createSafeLog } from "./safe-log.js";
import { SESSION_TIMEZONE_PIN_FILE_NAME } from "./session-timezone-contract.js";

export * from "./session-timezone-contract.js";

export const SESSION_CONFIG_FILE_MODE = 0o600;

const MAXIMUM_SESSION_TIMEZONE_PIN_FILE_BYTES = 256;
const MAXIMUM_SESSION_CONFIG_FILE_BYTES = 262144;

export function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
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

export function sessionTimezonePinPath(stateRoot: string): string {
  return join(stateRoot, SESSION_TIMEZONE_PIN_FILE_NAME);
}

export async function readSessionTimezonePin(stateRoot: string): Promise<boolean> {
  let contents: string;
  try {
    contents = await readFile(sessionTimezonePinPath(stateRoot), "utf8");
  } catch {
    return false;
  }
  if (contents.length > MAXIMUM_SESSION_TIMEZONE_PIN_FILE_BYTES) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return false;
  }
  if (!isRecord(parsed)) return false;
  if (!Number.isSafeInteger(parsed.schemaVersion) || (parsed.schemaVersion as number) < 1) {
    return false;
  }
  return parsed.pinned === true;
}

function storedSessionTimezone(document: unknown): string | undefined {
  if (!isRecord(document) || !isRecord(document.session)) return undefined;
  const timezone = document.session.timezone;
  return typeof timezone === "string" ? timezone : undefined;
}

function storedSessionTimezonePinned(document: unknown): boolean {
  return (
    isRecord(document) && isRecord(document.session) && document.session.timezonePinned === true
  );
}

function withSessionTimezone(document: Record<string, unknown>, timezone: string): string {
  const session = isRecord(document.session) ? { ...document.session } : {};
  session.timezone = timezone;
  return toYaml({ ...document, session });
}

export interface AdoptDeviceTimezoneInput {
  readonly configPath: string;
  readonly stateRoot: string;
  readonly env?: Record<string, string | undefined>;
  readonly platform?: NodeJS.Platform;
  readonly hostTimezone?: () => string | undefined;
  readonly log?: (message: string) => void;
}

export async function adoptDeviceTimezoneAtStart(input: AdoptDeviceTimezoneInput): Promise<void> {
  const platform = input.platform ?? process.platform;
  const environment = input.env ?? process.env;
  const log = createSafeLog(input.log);
  try {
    if (environmentTimezone(environment) !== undefined) return;
    if (await readSessionTimezonePin(input.stateRoot)) return;
    let contents: string;
    try {
      contents = await readFile(input.configPath, "utf8");
    } catch {
      return;
    }
    if (contents.length > MAXIMUM_SESSION_CONFIG_FILE_BYTES) return;
    let document: unknown;
    try {
      document = parseYaml(contents);
    } catch {
      return;
    }
    if (!isRecord(document)) return;
    if (storedSessionTimezonePinned(document)) return;
    const host = (input.hostTimezone ?? hostTimezoneFromRuntime)()?.trim() ?? "";
    if (host.length === 0 || !isValidTimezone(host)) return;
    if ((storedSessionTimezone(document)?.trim() ?? "") === host) return;
    const outcome = await durableAtomicReplace({
      root: dirname(input.configPath),
      fileName: basename(input.configPath),
      contents: withSessionTimezone(document, host),
      mode: SESSION_CONFIG_FILE_MODE,
      platform,
    });
    if (outcome.state === "durably-committed") log("desktop-session-timezone-adopted");
  } catch {
    return;
  }
}
