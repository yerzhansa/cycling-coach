import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { AthleteHomeIdentitySchema, type AthleteHomeIdentity } from "@enduragent/coach-contract";
import type { PowerMonitor } from "electron";

export const TELEGRAM_POWER_STATE_FILE_NAME = "power-state.json" as const;
export const TELEGRAM_POWER_STATE_DIRECTORY_MODE = 0o700;
export const TELEGRAM_POWER_STATE_FILE_MODE = 0o600;
export const TELEGRAM_POSSIBLE_MESSAGE_LOSS_AFTER_MS = 24 * 60 * 60 * 1_000;

const MAX_STATE_FILE_BYTES = 4_096;

export type TelegramGapWarning =
  | Readonly<{ state: "clear" }>
  | Readonly<{ state: "possible-message-loss"; detectedAt: string }>;

export type TelegramPowerFailure =
  | "clock"
  | "read-state"
  | "write-state"
  | "stop-polling"
  | "reconcile-polling";

export interface TelegramPowerControllerPort {
  stopPolling(): Promise<unknown>;
  reconcile(): Promise<unknown>;
}

export type TelegramPowerMonitorPort = Pick<PowerMonitor, "on" | "off">;

export interface DesktopTelegramPowerLifecycle {
  start(): Promise<TelegramGapWarning>;
  warning(): Promise<TelegramGapWarning>;
  acknowledgeWarning(): Promise<TelegramGapWarning>;
  close(): void;
}

export interface CreateDesktopTelegramPowerLifecycleInput {
  readonly root: string;
  readonly athleteHome: AthleteHomeIdentity;
  readonly powerMonitor: TelegramPowerMonitorPort;
  readonly controller: TelegramPowerControllerPort;
  readonly now?: () => number;
  readonly createId?: () => string;
  readonly reportFailure?: (failure: TelegramPowerFailure) => void;
  readonly observeWarning?: (warning: TelegramGapWarning) => void;
}

interface TelegramPowerStateRecord {
  readonly schemaVersion: 1;
  readonly athleteHome: AthleteHomeIdentity;
  readonly suspendedAt: string | null;
  readonly warningDetectedAt: string | null;
}

class TelegramPowerStateScopeMismatch extends Error {}

const CLEAR_WARNING: TelegramGapWarning = Object.freeze({ state: "clear" });

function permissions(mode: number): number {
  return mode & 0o777;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function canonicalTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 40) return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return undefined;
  const canonical = new Date(parsed).toISOString();
  return canonical === value ? canonical : undefined;
}

function parseState(
  contents: string,
  athleteHome: AthleteHomeIdentity,
): TelegramPowerStateRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  if (!exactKeys(record, ["athleteHome", "schemaVersion", "suspendedAt", "warningDetectedAt"])) {
    return undefined;
  }
  const parsedHome = AthleteHomeIdentitySchema.safeParse(record.athleteHome);
  const suspendedAt =
    record.suspendedAt === null ? null : (canonicalTimestamp(record.suspendedAt) ?? undefined);
  const warningDetectedAt =
    record.warningDetectedAt === null
      ? null
      : (canonicalTimestamp(record.warningDetectedAt) ?? undefined);
  if (parsedHome.success && parsedHome.data !== athleteHome) {
    throw new TelegramPowerStateScopeMismatch();
  }
  if (
    record.schemaVersion !== 1 ||
    !parsedHome.success ||
    suspendedAt === undefined ||
    warningDetectedAt === undefined
  ) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    athleteHome,
    suspendedAt,
    warningDetectedAt,
  };
}

function assertOwner(metadata: Stats, mode: number): void {
  if (
    metadata.isSymbolicLink() ||
    permissions(metadata.mode) !== mode ||
    (typeof process.getuid === "function" && metadata.uid !== process.getuid())
  ) {
    throw new TypeError("unsafe Telegram power state path");
  }
}

async function assertDirectory(root: string, create: boolean): Promise<void> {
  if (create) await mkdir(root, { recursive: true, mode: TELEGRAM_POWER_STATE_DIRECTORY_MODE });
  const metadata = await lstat(root);
  if (!metadata.isDirectory()) throw new TypeError("Telegram power state root is not a directory");
  assertOwner(metadata, TELEGRAM_POWER_STATE_DIRECTORY_MODE);
}

function emptyState(athleteHome: AthleteHomeIdentity): TelegramPowerStateRecord {
  return {
    schemaVersion: 1,
    athleteHome,
    suspendedAt: null,
    warningDetectedAt: null,
  };
}

function createStateStore(input: {
  readonly root: string;
  readonly athleteHome: AthleteHomeIdentity;
  readonly createId: () => string;
}) {
  const target = join(input.root, TELEGRAM_POWER_STATE_FILE_NAME);

  const read = async (): Promise<TelegramPowerStateRecord> => {
    let rootMetadata;
    try {
      rootMetadata = await lstat(input.root);
    } catch (error) {
      if (isMissing(error)) return emptyState(input.athleteHome);
      throw error;
    }
    if (!rootMetadata.isDirectory()) throw new TypeError("invalid Telegram power state root");
    assertOwner(rootMetadata, TELEGRAM_POWER_STATE_DIRECTORY_MODE);

    let before;
    try {
      before = await lstat(target);
    } catch (error) {
      if (isMissing(error)) return emptyState(input.athleteHome);
      throw error;
    }
    if (!before.isFile() || before.size > MAX_STATE_FILE_BYTES) {
      throw new TypeError("invalid Telegram power state file");
    }
    assertOwner(before, TELEGRAM_POWER_STATE_FILE_MODE);
    const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
    const handle = await open(target, flags);
    try {
      const opened = await handle.stat();
      if (
        !opened.isFile() ||
        opened.dev !== before.dev ||
        opened.ino !== before.ino ||
        opened.size > MAX_STATE_FILE_BYTES
      ) {
        throw new TypeError("Telegram power state changed while opening");
      }
      assertOwner(opened, TELEGRAM_POWER_STATE_FILE_MODE);
      const contents = await handle.readFile("utf8");
      const state = parseState(contents, input.athleteHome);
      if (state === undefined) throw new TypeError("invalid Telegram power state record");
      return state;
    } finally {
      await handle.close();
    }
  };

  const write = async (state: TelegramPowerStateRecord): Promise<void> => {
    await assertDirectory(input.root, true);
    try {
      const existing = await lstat(target);
      if (!existing.isFile()) throw new TypeError("invalid Telegram power state target");
      assertOwner(existing, TELEGRAM_POWER_STATE_FILE_MODE);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const id = input.createId();
    if (!/^[A-Za-z0-9-]{1,128}$/.test(id)) throw new TypeError("invalid temporary file id");
    const temporary = join(input.root, `.${TELEGRAM_POWER_STATE_FILE_NAME}.${id}.tmp`);
    let handle;
    try {
      handle = await open(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
        TELEGRAM_POWER_STATE_FILE_MODE,
      );
      await handle.chmod(TELEGRAM_POWER_STATE_FILE_MODE);
      await handle.writeFile(`${JSON.stringify(state)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, target);
      const directory = await open(input.root, constants.O_RDONLY);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  };

  return { read, write };
}

function warningFor(state: TelegramPowerStateRecord): TelegramGapWarning {
  return state.warningDetectedAt === null
    ? CLEAR_WARNING
    : { state: "possible-message-loss", detectedAt: state.warningDetectedAt };
}

function timestamp(now: () => number): string {
  const value = now();
  if (!Number.isFinite(value) || value < 0 || value > 8_640_000_000_000_000) {
    throw new TypeError("invalid clock");
  }
  return new Date(value).toISOString();
}

export function createDesktopTelegramPowerLifecycle(
  input: CreateDesktopTelegramPowerLifecycleInput,
): DesktopTelegramPowerLifecycle {
  const athleteHome = AthleteHomeIdentitySchema.parse(input.athleteHome);
  const now = input.now ?? Date.now;
  const store = createStateStore({
    root: input.root,
    athleteHome,
    createId: input.createId ?? randomUUID,
  });
  let cached: TelegramGapWarning = CLEAR_WARNING;
  let pending: Promise<void> = Promise.resolve();
  let started = false;
  let closed = false;
  let scopeMismatch = false;

  const report = (failure: TelegramPowerFailure): void => {
    try {
      input.reportFailure?.(failure);
    } catch {}
  };
  const publish = (warning: TelegramGapWarning): TelegramGapWarning => {
    cached = warning;
    try {
      input.observeWarning?.(warning);
    } catch {}
    return warning;
  };
  const uncertain = (): TelegramGapWarning => {
    if (cached.state === "possible-message-loss") return publish(cached);
    let detectedAt = "1970-01-01T00:00:00.000Z";
    try {
      detectedAt = timestamp(now);
    } catch {}
    return publish({ state: "possible-message-loss", detectedAt });
  };
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = pending.then(operation);
    pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const readState = async (): Promise<TelegramPowerStateRecord | undefined> => {
    try {
      const state = await store.read();
      scopeMismatch = false;
      return state;
    } catch (error) {
      scopeMismatch = error instanceof TelegramPowerStateScopeMismatch;
      report("read-state");
      uncertain();
      return undefined;
    }
  };
  const writeState = async (state: TelegramPowerStateRecord): Promise<boolean> => {
    try {
      await store.write(state);
      return true;
    } catch {
      report("write-state");
      uncertain();
      return false;
    }
  };
  const retainedWarning = (state: TelegramPowerStateRecord): string | null =>
    state.warningDetectedAt ??
    (cached.state === "possible-message-loss" ? cached.detectedAt : null);
  const stopPolling = async (): Promise<void> => {
    try {
      await input.controller.stopPolling();
    } catch {
      report("stop-polling");
    }
  };
  const reconcilePolling = async (): Promise<void> => {
    try {
      await input.controller.reconcile();
    } catch {
      report("reconcile-polling");
    }
  };
  const finishGap = async (endedAt: string): Promise<TelegramGapWarning> => {
    const state = await readState();
    if (state === undefined) return cached;
    if (state.suspendedAt === null) {
      const warningDetectedAt = retainedWarning(state);
      return publish(warningFor({ ...state, warningDetectedAt }));
    }
    const gap = Date.parse(endedAt) - Date.parse(state.suspendedAt);
    const warningDetectedAt =
      retainedWarning(state) ??
      (gap < 0 || gap >= TELEGRAM_POSSIBLE_MESSAGE_LOSS_AFTER_MS ? endedAt : null);
    const next = { ...state, suspendedAt: null, warningDetectedAt };
    if (!(await writeState(next))) return cached;
    return publish(warningFor(next));
  };
  const recover = async (): Promise<TelegramGapWarning> => {
    const state = await readState();
    if (state === undefined) return cached;
    if (state.suspendedAt === null) {
      const warningDetectedAt = retainedWarning(state);
      return publish(warningFor({ ...state, warningDetectedAt }));
    }
    let recoveredAt: string;
    try {
      recoveredAt = timestamp(now);
    } catch {
      report("clock");
      uncertain();
      recoveredAt =
        cached.state === "possible-message-loss" ? cached.detectedAt : "1970-01-01T00:00:00.000Z";
    }
    const warning = await finishGap(recoveredAt);
    await stopPolling();
    await reconcilePolling();
    return warning;
  };
  const onSuspend = (): void => {
    let suspendedAt: string;
    try {
      suspendedAt = timestamp(now);
    } catch {
      report("clock");
      uncertain();
      suspendedAt =
        cached.state === "possible-message-loss" ? cached.detectedAt : "1970-01-01T00:00:00.000Z";
    }
    void serialize(async () => {
      const state = await readState();
      if (state !== undefined) {
        const next = {
          ...state,
          suspendedAt: state.suspendedAt ?? suspendedAt,
          warningDetectedAt: retainedWarning(state),
        };
        if (await writeState(next)) publish(warningFor(next));
      }
      await stopPolling();
    });
  };
  const onResume = (): void => {
    let resumedAt: string;
    try {
      resumedAt = timestamp(now);
    } catch {
      report("clock");
      uncertain();
      resumedAt =
        cached.state === "possible-message-loss" ? cached.detectedAt : "1970-01-01T00:00:00.000Z";
    }
    void serialize(async () => {
      await finishGap(resumedAt);
      await stopPolling();
      await reconcilePolling();
    });
  };

  return {
    start() {
      if (closed) return Promise.reject(new TypeError("Telegram power lifecycle is closed"));
      if (!started) {
        started = true;
        input.powerMonitor.on("suspend", onSuspend);
        input.powerMonitor.on("resume", onResume);
      }
      return serialize(recover);
    },
    warning() {
      return serialize(async () => {
        const state = await readState();
        if (state === undefined) return cached;
        const warningDetectedAt = retainedWarning(state);
        return publish(warningFor({ ...state, warningDetectedAt }));
      });
    },
    acknowledgeWarning() {
      return serialize(async () => {
        const state = await readState();
        if (state === undefined && scopeMismatch) return cached;
        const cleared = {
          ...(state ?? emptyState(athleteHome)),
          warningDetectedAt: null,
        };
        if (!(await writeState(cleared))) return cached;
        return publish(CLEAR_WARNING);
      });
    },
    close() {
      if (closed) return;
      closed = true;
      if (started) {
        input.powerMonitor.off("suspend", onSuspend);
        input.powerMonitor.off("resume", onResume);
      }
    },
  };
}
