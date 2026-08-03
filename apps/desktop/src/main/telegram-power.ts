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
  | "read-polling-status"
  | "stop-polling"
  | "reconcile-polling";

export interface TelegramPowerControllerPort {
  stopPolling(): Promise<unknown>;
  reconcile(): Promise<unknown>;
  status(): Promise<unknown>;
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
  readonly schemaVersion: 2;
  readonly athleteHome: AthleteHomeIdentity;
  readonly gapStartedAt: string | null;
  readonly lastSuccessfulPollAt: string | null;
  readonly suspendedAt: string | null;
  readonly warningDetectedAt: string | null;
}

interface TelegramPollingHealthObservation {
  readonly desiredState: "disabled" | "enabled";
  readonly state: string;
  readonly lastSuccessfulPollAt: string | null;
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

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pollingHealth(value: unknown): TelegramPollingHealthObservation | undefined {
  if (!record(value) || !record(value.channel)) return undefined;
  const channel = value.channel;
  if (
    (channel.desiredState !== "disabled" && channel.desiredState !== "enabled") ||
    typeof channel.state !== "string"
  ) {
    return undefined;
  }
  const lastSuccessfulPollAt =
    channel.lastSuccessfulPollAt === undefined
      ? null
      : (canonicalTimestamp(channel.lastSuccessfulPollAt) ?? null);
  return {
    desiredState: channel.desiredState,
    state: channel.state,
    lastSuccessfulPollAt,
  };
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
  if (!parsedHome.success || suspendedAt === undefined || warningDetectedAt === undefined) {
    return undefined;
  }
  if (
    record.schemaVersion === 1 &&
    exactKeys(record, ["athleteHome", "schemaVersion", "suspendedAt", "warningDetectedAt"])
  ) {
    return {
      schemaVersion: 2,
      athleteHome,
      gapStartedAt: suspendedAt,
      lastSuccessfulPollAt: null,
      suspendedAt,
      warningDetectedAt,
    };
  }
  if (
    record.schemaVersion !== 2 ||
    !exactKeys(record, [
      "athleteHome",
      "gapStartedAt",
      "lastSuccessfulPollAt",
      "schemaVersion",
      "suspendedAt",
      "warningDetectedAt",
    ])
  ) {
    return undefined;
  }
  const gapStartedAt =
    record.gapStartedAt === null ? null : (canonicalTimestamp(record.gapStartedAt) ?? undefined);
  const lastSuccessfulPollAt =
    record.lastSuccessfulPollAt === null
      ? null
      : (canonicalTimestamp(record.lastSuccessfulPollAt) ?? undefined);
  if (gapStartedAt === undefined || lastSuccessfulPollAt === undefined) return undefined;
  return {
    schemaVersion: 2,
    athleteHome,
    gapStartedAt,
    lastSuccessfulPollAt,
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
    schemaVersion: 2,
    athleteHome,
    gapStartedAt: null,
    lastSuccessfulPollAt: null,
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
  const warnForGap = (
    state: TelegramPowerStateRecord,
    startedAt: string | null,
    endedAt: string,
    detectedAt: string,
  ): string | null => {
    const retained = retainedWarning(state);
    if (retained !== null || startedAt === null) return retained;
    const gap = Date.parse(endedAt) - Date.parse(startedAt);
    return gap < 0 || gap >= TELEGRAM_POSSIBLE_MESSAGE_LOSS_AFTER_MS ? detectedAt : null;
  };
  const publishState = async (state: TelegramPowerStateRecord): Promise<TelegramGapWarning> => {
    if (!(await writeState(state))) return cached;
    return publish(warningFor(state));
  };
  const laterTimestamp = (left: string | null, right: string | null): string | null => {
    if (left === null) return right;
    if (right === null) return left;
    return Date.parse(left) >= Date.parse(right) ? left : right;
  };
  const observedAt = (): string | undefined => {
    try {
      return timestamp(now);
    } catch {
      report("clock");
      uncertain();
      return undefined;
    }
  };
  const stopPolling = async (): Promise<void> => {
    try {
      await input.controller.stopPolling();
    } catch {
      report("stop-polling");
    }
  };
  const reconcilePolling = async (): Promise<unknown> => {
    try {
      return await input.controller.reconcile();
    } catch {
      report("reconcile-polling");
      return undefined;
    }
  };
  const applyPollingHealth = async (
    value: unknown,
    observationTime: string,
  ): Promise<TelegramGapWarning | undefined> => {
    const health = pollingHealth(value);
    if (health === undefined) return undefined;
    const state = await readState();
    if (state === undefined) return cached;
    const reportedSuccessfulAt =
      health.lastSuccessfulPollAt !== null &&
      Date.parse(health.lastSuccessfulPollAt) <= Date.parse(observationTime)
        ? health.lastSuccessfulPollAt
        : null;
    const lastSuccessfulPollAt = laterTimestamp(state.lastSuccessfulPollAt, reportedSuccessfulAt);
    if (health.desiredState === "disabled") {
      return publishState({
        ...state,
        gapStartedAt: null,
        lastSuccessfulPollAt: null,
        warningDetectedAt: retainedWarning(state),
      });
    }
    if (health.state === "online") {
      const successfulAt = laterTimestamp(
        state.lastSuccessfulPollAt,
        reportedSuccessfulAt ?? observationTime,
      )!;
      return publishState({
        ...state,
        gapStartedAt: null,
        lastSuccessfulPollAt: successfulAt,
        warningDetectedAt: warnForGap(
          state,
          state.gapStartedAt ?? state.suspendedAt,
          successfulAt,
          observationTime,
        ),
      });
    }
    const gapStartedAt = state.gapStartedAt ?? lastSuccessfulPollAt ?? observationTime;
    return publishState({
      ...state,
      gapStartedAt,
      lastSuccessfulPollAt,
      warningDetectedAt: warnForGap(state, gapStartedAt, observationTime, observationTime),
    });
  };
  const refreshOpenGap = async (observationTime: string): Promise<TelegramGapWarning> => {
    const state = await readState();
    if (state === undefined) return cached;
    const warningDetectedAt = warnForGap(
      state,
      state.gapStartedAt,
      observationTime,
      observationTime,
    );
    if (warningDetectedAt === state.warningDetectedAt) {
      return publish(warningFor({ ...state, warningDetectedAt }));
    }
    return publishState({ ...state, warningDetectedAt });
  };
  const samplePollingHealth = async (): Promise<TelegramGapWarning> => {
    const observationTime = observedAt();
    if (observationTime === undefined) return cached;
    let value: unknown;
    try {
      value = await input.controller.status();
    } catch {
      report("read-polling-status");
      return refreshOpenGap(observationTime);
    }
    return (await applyPollingHealth(value, observationTime)) ?? refreshOpenGap(observationTime);
  };
  const finishGap = async (
    endedAt: string,
    detectNewWarning = true,
  ): Promise<TelegramGapWarning> => {
    const state = await readState();
    if (state === undefined) return cached;
    if (state.suspendedAt === null) {
      const warningDetectedAt = retainedWarning(state);
      return publish(warningFor({ ...state, warningDetectedAt }));
    }
    const warningDetectedAt = detectNewWarning
      ? warnForGap(state, state.suspendedAt, endedAt, endedAt)
      : retainedWarning(state);
    return publishState({
      ...state,
      gapStartedAt: state.gapStartedAt ?? state.suspendedAt,
      suspendedAt: null,
      warningDetectedAt,
    });
  };
  const recover = async (): Promise<TelegramGapWarning> => {
    const state = await readState();
    if (state === undefined) return cached;
    if (state.suspendedAt === null) return samplePollingHealth();
    const recoveredAt = observedAt();
    if (recoveredAt === undefined) return cached;
    await finishGap(recoveredAt, false);
    await stopPolling();
    const reconciled = await reconcilePolling();
    return (await applyPollingHealth(reconciled, recoveredAt)) ?? refreshOpenGap(recoveredAt);
  };
  const onSuspend = (): void => {
    const suspendedAt = observedAt();
    if (suspendedAt === undefined) return;
    void serialize(async () => {
      const state = await readState();
      if (state !== undefined) {
        const next = {
          ...state,
          gapStartedAt: state.gapStartedAt ?? suspendedAt,
          suspendedAt: state.suspendedAt ?? suspendedAt,
          warningDetectedAt: retainedWarning(state),
        };
        if (await writeState(next)) publish(warningFor(next));
      }
      await stopPolling();
    });
  };
  const onResume = (): void => {
    const resumedAt = observedAt();
    if (resumedAt === undefined) return;
    void serialize(async () => {
      await finishGap(resumedAt, false);
      await stopPolling();
      const reconciled = await reconcilePolling();
      if ((await applyPollingHealth(reconciled, resumedAt)) === undefined) {
        await refreshOpenGap(resumedAt);
      }
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
      return serialize(samplePollingHealth);
    },
    acknowledgeWarning() {
      return serialize(async () => {
        const state = await readState();
        if (state === undefined && scopeMismatch) return cached;
        const acknowledgedAt = observedAt();
        if (acknowledgedAt === undefined) return cached;
        const current = state ?? emptyState(athleteHome);
        const cleared = {
          ...current,
          gapStartedAt: current.gapStartedAt === null ? null : acknowledgedAt,
          suspendedAt: current.suspendedAt === null ? null : acknowledgedAt,
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
