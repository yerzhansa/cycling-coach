import { EventEmitter } from "node:events";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AthleteHomeIdentitySchema } from "@enduragent/coach-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDesktopTelegramPowerLifecycle,
  TELEGRAM_POSSIBLE_MESSAGE_LOSS_AFTER_MS,
  TELEGRAM_POWER_STATE_DIRECTORY_MODE,
  TELEGRAM_POWER_STATE_FILE_MODE,
  TELEGRAM_POWER_STATE_FILE_NAME,
  type TelegramPowerMonitorPort,
} from "../src/main/telegram-power.js";

const scratchDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    scratchDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture() {
  const scratch = await mkdtemp(join(tmpdir(), "enduragent-telegram-power-"));
  scratchDirectories.push(scratch);
  return {
    root: join(scratch, "telegram"),
    athleteHome: AthleteHomeIdentitySchema.parse(join(scratch, "athlete")),
  };
}

async function publishUnsyncedPowerState(
  files: Awaited<ReturnType<typeof fixture>>,
  warningDetectedAt: string,
): Promise<void> {
  await mkdir(files.root, { recursive: true, mode: TELEGRAM_POWER_STATE_DIRECTORY_MODE });
  const temporary = join(files.root, `.${TELEGRAM_POWER_STATE_FILE_NAME}.crash.tmp`);
  const target = join(files.root, TELEGRAM_POWER_STATE_FILE_NAME);
  const handle = await open(temporary, "wx", TELEGRAM_POWER_STATE_FILE_MODE);
  try {
    await handle.writeFile(
      `${JSON.stringify({
        schemaVersion: 2,
        athleteHome: files.athleteHome,
        gapStartedAt: null,
        lastSuccessfulPollAt: null,
        suspendedAt: null,
        warningDetectedAt,
      })}\n`,
    );
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, target);
}

function monitor(): EventEmitter & TelegramPowerMonitorPort {
  return new EventEmitter() as EventEmitter & TelegramPowerMonitorPort;
}

function controller() {
  return {
    stopPolling: vi.fn<() => Promise<unknown>>(async () => undefined),
    resumePolling: vi.fn<() => Promise<unknown>>(async () => undefined),
    status: vi.fn<() => Promise<unknown>>(async () => undefined),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function pollingStatus(state: "online" | "offline-retrying", lastSuccessfulPollAt?: string) {
  return {
    channel: {
      desiredState: "enabled" as const,
      state,
      ...(lastSuccessfulPollAt === undefined ? {} : { lastSuccessfulPollAt }),
    },
  };
}

function disabledPollingStatus() {
  return { channel: { desiredState: "disabled" as const, state: "disabled" as const } };
}

describe("Desktop Telegram power lifecycle", () => {
  const posixIt = it.skipIf(process.platform === "win32");

  posixIt("keeps the forward gap anchor and warns when its rename is visible but durability is uncertain", async () => {
    const files = await fixture();
    const powerMonitor = monitor();
    const telegram = controller();
    const suspendedAt = Date.parse("2026-08-01T00:00:00.000Z");
    let syncCount = 0;
    let id = 0;
    const lifecycle = createDesktopTelegramPowerLifecycle({
      ...files,
      powerMonitor,
      controller: telegram,
      now: () => suspendedAt,
      createId: () => `state-${++id}`,
      syncDirectory: async () => {
        syncCount += 1;
        if (syncCount === 1) {
          throw Object.assign(new Error("synthetic first directory sync failure"), { code: "EIO" });
        }
        const directory = await open(files.root, "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      },
    });
    await lifecycle.start();

    powerMonitor.emit("suspend");
    await vi.waitFor(() => expect(telegram.stopPolling).toHaveBeenCalledOnce());

    await expect(lifecycle.warning()).resolves.toEqual({
      state: "possible-message-loss",
      detectedAt: "2026-08-01T00:00:00.000Z",
    });
    const stored = JSON.parse(
      await readFile(join(files.root, TELEGRAM_POWER_STATE_FILE_NAME), "utf8"),
    );
    expect(stored).toMatchObject({
      gapStartedAt: "2026-08-01T00:00:00.000Z",
      suspendedAt: "2026-08-01T00:00:00.000Z",
    });
  });

  it("does not stop polling when the suspend anchor fails before it becomes visible", async () => {
    const files = await fixture();
    const powerMonitor = monitor();
    const telegram = controller();
    const suspendedAt = Date.parse("2026-08-01T00:00:00.000Z");
    const lifecycle = createDesktopTelegramPowerLifecycle({
      ...files,
      powerMonitor,
      controller: telegram,
      now: () => suspendedAt,
      createId: () => "pre-rename-failure",
      renameFile: async () => {
        throw new TypeError("synthetic pre-rename failure");
      },
    });
    await lifecycle.start();

    powerMonitor.emit("suspend");
    await expect(lifecycle.warning()).resolves.toEqual({
      state: "possible-message-loss",
      detectedAt: "2026-08-01T00:00:00.000Z",
    });

    expect(telegram.stopPolling).not.toHaveBeenCalled();
    await expect(lstat(join(files.root, TELEGRAM_POWER_STATE_FILE_NAME))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  posixIt("does not stop polling before the power-state namespace is durably anchored", async () => {
    const files = await fixture();
    const powerMonitor = monitor();
    const telegram = controller();
    const syncParentDirectory = vi.fn(async (path: string) => {
      expect(path).toBe(dirname(files.root));
      throw Object.assign(new Error("synthetic parent sync failure"), { code: "EIO" });
    });
    const lifecycle = createDesktopTelegramPowerLifecycle({
      ...files,
      powerMonitor,
      controller: telegram,
      now: () => Date.parse("2026-08-01T00:00:00.000Z"),
      createId: () => "unanchored-namespace",
      syncParentDirectory,
    });
    await lifecycle.start();

    powerMonitor.emit("suspend");
    await expect(lifecycle.warning()).resolves.toEqual({
      state: "possible-message-loss",
      detectedAt: "2026-08-01T00:00:00.000Z",
    });

    expect(syncParentDirectory).toHaveBeenCalled();
    expect(syncParentDirectory.mock.calls.every(([path]) => path === dirname(files.root))).toBe(
      true,
    );
    expect(telegram.stopPolling).not.toHaveBeenCalled();
    await expect(lstat(join(files.root, TELEGRAM_POWER_STATE_FILE_NAME))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  posixIt("fsyncs and accepts the visible power record after reconstructing the lifecycle", async () => {
    const files = await fixture();
    await publishUnsyncedPowerState(files, "2026-08-01T00:00:00.000Z");
    const syncDirectory = vi.fn(async () => {
      const directory = await open(files.root, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    });
    const lifecycle = createDesktopTelegramPowerLifecycle({
      ...files,
      powerMonitor: monitor(),
      controller: controller(),
      now: () => Date.parse("2026-08-02T00:00:00.000Z"),
      syncDirectory,
    });

    await expect(lifecycle.start()).resolves.toEqual({
      state: "possible-message-loss",
      detectedAt: "2026-08-01T00:00:00.000Z",
    });
    expect(syncDirectory).toHaveBeenCalledOnce();
  });

  posixIt("fails closed without power mutations when reopen convergence cannot be proven", async () => {
    const files = await fixture();
    await publishUnsyncedPowerState(files, "2026-08-01T00:00:00.000Z");
    const telegram = controller();
    const syncDirectory = vi.fn(async () => {
      throw Object.assign(new Error("synthetic reopen sync failure"), { code: "EIO" });
    });
    const lifecycle = createDesktopTelegramPowerLifecycle({
      ...files,
      powerMonitor: monitor(),
      controller: telegram,
      now: () => Date.parse("2026-08-02T00:00:00.000Z"),
      syncDirectory,
    });

    await expect(lifecycle.start()).resolves.toEqual({
      state: "possible-message-loss",
      detectedAt: "2026-08-02T00:00:00.000Z",
    });
    await expect(lifecycle.warning()).resolves.toEqual({
      state: "possible-message-loss",
      detectedAt: "2026-08-02T00:00:00.000Z",
    });
    expect(syncDirectory).toHaveBeenCalledOnce();
    expect(telegram.stopPolling).not.toHaveBeenCalled();
    expect(telegram.resumePolling).not.toHaveBeenCalled();
  });

  it("warns after an exact-24-hour awake polling-health gap", async () => {
    const files = await fixture();
    const startedAt = Date.parse("2026-08-01T00:00:00.000Z");
    let now = startedAt;
    const telegram = controller();
    telegram.status
      .mockResolvedValueOnce(pollingStatus("online", "2026-08-01T00:00:00.000Z"))
      .mockResolvedValueOnce(pollingStatus("offline-retrying", "2026-08-01T00:00:00.000Z"))
      .mockResolvedValueOnce(pollingStatus("online", "2026-08-02T00:00:00.000Z"));
    const lifecycle = createDesktopTelegramPowerLifecycle({
      ...files,
      powerMonitor: monitor(),
      controller: telegram,
      now: () => now,
      createId: (() => {
        let id = 0;
        return () => `state-${++id}`;
      })(),
    });

    await expect(lifecycle.start()).resolves.toEqual({ state: "clear" });
    now += 60_000;
    await expect(lifecycle.warning()).resolves.toEqual({ state: "clear" });
    now = startedAt + TELEGRAM_POSSIBLE_MESSAGE_LOSS_AFTER_MS;
    await expect(lifecycle.warning()).resolves.toEqual({
      state: "possible-message-loss",
      detectedAt: "2026-08-02T00:00:00.000Z",
    });
  });

  it("does not warn after a 23-hour-59-minute awake polling-health gap", async () => {
    const files = await fixture();
    const startedAt = Date.parse("2026-08-01T00:00:00.000Z");
    let now = startedAt;
    const telegram = controller();
    telegram.status
      .mockResolvedValueOnce(pollingStatus("online", "2026-08-01T00:00:00.000Z"))
      .mockResolvedValueOnce(pollingStatus("offline-retrying", "2026-08-01T00:00:00.000Z"))
      .mockResolvedValueOnce(pollingStatus("online", "2026-08-01T23:59:00.000Z"));
    const lifecycle = createDesktopTelegramPowerLifecycle({
      ...files,
      powerMonitor: monitor(),
      controller: telegram,
      now: () => now,
      createId: (() => {
        let id = 0;
        return () => `state-${++id}`;
      })(),
    });

    await lifecycle.start();
    now += 60_000;
    await lifecycle.warning();
    now = startedAt + TELEGRAM_POSSIBLE_MESSAGE_LOSS_AFTER_MS - 60_000;
    await expect(lifecycle.warning()).resolves.toEqual({ state: "clear" });
  });

  it("preserves an awake polling-health gap across process restart", async () => {
    const files = await fixture();
    const startedAt = Date.parse("2026-08-01T00:00:00.000Z");
    let now = startedAt;
    let ids = 0;
    const firstController = controller();
    firstController.status
      .mockResolvedValueOnce(pollingStatus("online", "2026-08-01T00:00:00.000Z"))
      .mockResolvedValueOnce(pollingStatus("offline-retrying", "2026-08-01T00:00:00.000Z"));
    const first = createDesktopTelegramPowerLifecycle({
      ...files,
      powerMonitor: monitor(),
      controller: firstController,
      now: () => now,
      createId: () => `state-${++ids}`,
    });
    await first.start();
    now += 60_000;
    await first.warning();
    await first.close();

    now = startedAt + 12 * 60 * 60 * 1_000;
    const restartedController = controller();
    restartedController.status.mockResolvedValueOnce(
      pollingStatus("offline-retrying", "2026-08-01T00:00:00.000Z"),
    );
    const restarted = createDesktopTelegramPowerLifecycle({
      ...files,
      powerMonitor: monitor(),
      controller: restartedController,
      now: () => now,
      createId: () => `state-${++ids}`,
    });
    await expect(restarted.start()).resolves.toEqual({ state: "clear" });
    await restarted.close();

    now = startedAt + TELEGRAM_POSSIBLE_MESSAGE_LOSS_AFTER_MS;
    const recoveredController = controller();
    recoveredController.status.mockResolvedValueOnce(
      pollingStatus("online", "2026-08-02T00:00:00.000Z"),
    );
    const recovered = createDesktopTelegramPowerLifecycle({
      ...files,
      powerMonitor: monitor(),
      controller: recoveredController,
      now: () => now,
      createId: () => `state-${++ids}`,
    });
    await expect(recovered.start()).resolves.toEqual({
      state: "possible-message-loss",
      detectedAt: "2026-08-02T00:00:00.000Z",
    });
  });

  it("uses a redacted observation-time fallback when polling health omits its timestamp", async () => {
    const files = await fixture();
    const now = Date.parse("2026-08-01T00:00:00.000Z");
    const telegram = controller();
    telegram.status.mockResolvedValueOnce(pollingStatus("online"));
    const lifecycle = createDesktopTelegramPowerLifecycle({
      ...files,
      powerMonitor: monitor(),
      controller: telegram,
      now: () => now,
      createId: () => "fallback",
    });

    await lifecycle.start();
    expect(
      JSON.parse(await readFile(join(files.root, TELEGRAM_POWER_STATE_FILE_NAME), "utf8")),
    ).toMatchObject({
      gapStartedAt: null,
      lastSuccessfulPollAt: "2026-08-01T00:00:00.000Z",
    });
  });

  it("durably records suspend before stopping and reconciles after a short resume", async () => {
    const files = await fixture();
    const powerMonitor = monitor();
    const telegram = controller();
    let now = Date.parse("2026-08-01T00:00:00.000Z");
    const lifecycle = createDesktopTelegramPowerLifecycle({
      ...files,
      powerMonitor,
      controller: telegram,
      now: () => now,
      createId: (() => {
        let id = 0;
        return () => `state-${++id}`;
      })(),
    });

    await expect(lifecycle.start()).resolves.toEqual({ state: "clear" });
    expect(powerMonitor.emit("suspend")).toBe(true);
    await expect(lifecycle.warning()).resolves.toEqual({ state: "clear" });
    expect(telegram.stopPolling).toHaveBeenCalledOnce();
    expect(telegram.resumePolling).not.toHaveBeenCalled();

    const target = join(files.root, TELEGRAM_POWER_STATE_FILE_NAME);
    if (process.platform === "win32") {
      expect((await lstat(target)).nlink).toBe(1);
    } else {
      expect((await lstat(files.root)).mode & 0o777).toBe(TELEGRAM_POWER_STATE_DIRECTORY_MODE);
      expect((await lstat(target)).mode & 0o777).toBe(TELEGRAM_POWER_STATE_FILE_MODE);
    }
    const suspended = JSON.parse(await readFile(target, "utf8"));
    expect(suspended).toEqual({
      schemaVersion: 2,
      athleteHome: files.athleteHome,
      gapStartedAt: "2026-08-01T00:00:00.000Z",
      lastSuccessfulPollAt: null,
      suspendedAt: "2026-08-01T00:00:00.000Z",
      warningDetectedAt: null,
    });
    expect(Object.keys(suspended).sort()).toEqual([
      "athleteHome",
      "gapStartedAt",
      "lastSuccessfulPollAt",
      "schemaVersion",
      "suspendedAt",
      "warningDetectedAt",
    ]);

    now += TELEGRAM_POSSIBLE_MESSAGE_LOSS_AFTER_MS - 1;
    expect(powerMonitor.emit("resume")).toBe(true);
    await expect(lifecycle.warning()).resolves.toEqual({ state: "clear" });
    expect(telegram.stopPolling).toHaveBeenCalledTimes(2);
    expect(telegram.resumePolling).toHaveBeenCalledOnce();
    expect(JSON.parse(await readFile(target, "utf8"))).toMatchObject({
      suspendedAt: null,
      warningDetectedAt: null,
    });
  });

  it("does not open a possible-message-loss gap while Telegram is disabled", async () => {
    const files = await fixture();
    const powerMonitor = monitor();
    const telegram = controller();
    telegram.status.mockResolvedValue(disabledPollingStatus());
    telegram.resumePolling.mockResolvedValue(disabledPollingStatus());
    let now = Date.parse("2026-08-01T00:00:00.000Z");
    const lifecycle = createDesktopTelegramPowerLifecycle({
      ...files,
      powerMonitor,
      controller: telegram,
      now: () => now,
      createId: (() => {
        let id = 0;
        return () => `state-${++id}`;
      })(),
    });

    await lifecycle.start();
    powerMonitor.emit("suspend");
    await lifecycle.warning();
    now += TELEGRAM_POSSIBLE_MESSAGE_LOSS_AFTER_MS;
    powerMonitor.emit("resume");
    await expect(lifecycle.warning()).resolves.toEqual({ state: "clear" });
    expect(
      JSON.parse(await readFile(join(files.root, TELEGRAM_POWER_STATE_FILE_NAME), "utf8")),
    ).toMatchObject({
      gapStartedAt: null,
      lastSuccessfulPollAt: null,
      suspendedAt: null,
      warningDetectedAt: null,
    });
  });

  it("records suspend and stops polling without waiting for a later status read", async () => {
    const files = await fixture();
    const powerMonitor = monitor();
    const telegram = controller();
    telegram.status
      .mockResolvedValueOnce(pollingStatus("online", "2026-08-01T00:00:00.000Z"))
      .mockImplementation(() => new Promise(() => undefined));
    const lifecycle = createDesktopTelegramPowerLifecycle({
      ...files,
      powerMonitor,
      controller: telegram,
      now: () => Date.parse("2026-08-01T00:00:00.000Z"),
      createId: (() => {
        let id = 0;
        return () => `state-${++id}`;
      })(),
    });

    await lifecycle.start();
    powerMonitor.emit("suspend");
    await vi.waitFor(() => expect(telegram.stopPolling).toHaveBeenCalledOnce());
    expect(
      JSON.parse(await readFile(join(files.root, TELEGRAM_POWER_STATE_FILE_NAME), "utf8")),
    ).toMatchObject({
      gapStartedAt: "2026-08-01T00:00:00.000Z",
      suspendedAt: "2026-08-01T00:00:00.000Z",
    });
  });

  it("starts a fresh warning window when an open gap is acknowledged", async () => {
    const files = await fixture();
    const startedAt = Date.parse("2026-08-01T00:00:00.000Z");
    let now = startedAt;
    const telegram = controller();
    telegram.status.mockResolvedValue(
      pollingStatus("offline-retrying", "2026-08-01T00:00:00.000Z"),
    );
    const lifecycle = createDesktopTelegramPowerLifecycle({
      ...files,
      powerMonitor: monitor(),
      controller: telegram,
      now: () => now,
      createId: (() => {
        let id = 0;
        return () => `state-${++id}`;
      })(),
    });

    await lifecycle.start();
    now += TELEGRAM_POSSIBLE_MESSAGE_LOSS_AFTER_MS;
    await expect(lifecycle.warning()).resolves.toMatchObject({
      state: "possible-message-loss",
    });
    await expect(lifecycle.acknowledgeWarning()).resolves.toEqual({ state: "clear" });
    await expect(lifecycle.warning()).resolves.toEqual({ state: "clear" });
  });

  it("persists an exact-24-hour warning across process restart until acknowledgement", async () => {
    const files = await fixture();
    let now = Date.parse("2026-08-01T00:00:00.000Z");
    let ids = 0;
    const firstMonitor = monitor();
    const first = createDesktopTelegramPowerLifecycle({
      ...files,
      powerMonitor: firstMonitor,
      controller: controller(),
      now: () => now,
      createId: () => `state-${++ids}`,
    });
    await first.start();
    firstMonitor.emit("suspend");
    await first.warning();
    await first.close();

    now += TELEGRAM_POSSIBLE_MESSAGE_LOSS_AFTER_MS;
    const recoveredController = controller();
    const recovered = createDesktopTelegramPowerLifecycle({
      ...files,
      powerMonitor: monitor(),
      controller: recoveredController,
      now: () => now,
      createId: () => `state-${++ids}`,
    });
    const expectedWarning = {
      state: "possible-message-loss",
      detectedAt: "2026-08-02T00:00:00.000Z",
    } as const;
    await expect(recovered.start()).resolves.toEqual(expectedWarning);
    expect(recoveredController.stopPolling).toHaveBeenCalledOnce();
    expect(recoveredController.resumePolling).toHaveBeenCalledOnce();
    await recovered.close();

    const restarted = createDesktopTelegramPowerLifecycle({
      ...files,
      powerMonitor: monitor(),
      controller: controller(),
      now: () => now,
      createId: () => `state-${++ids}`,
    });
    await expect(restarted.start()).resolves.toEqual(expectedWarning);
    await expect(restarted.acknowledgeWarning()).resolves.toEqual({ state: "clear" });
    await restarted.close();

    const afterAcknowledgement = createDesktopTelegramPowerLifecycle({
      ...files,
      powerMonitor: monitor(),
      controller: controller(),
      now: () => now,
      createId: () => `state-${++ids}`,
    });
    await expect(afterAcknowledgement.start()).resolves.toEqual({ state: "clear" });
  });

  it("keeps only redacted lifecycle metadata in the durable record", async () => {
    const files = await fixture();
    const powerMonitor = monitor();
    const lifecycle = createDesktopTelegramPowerLifecycle({
      ...files,
      powerMonitor,
      controller: controller(),
      now: () => Date.parse("2026-08-01T00:00:00.000Z"),
      createId: () => "redacted",
    });
    await lifecycle.start();
    powerMonitor.emit("suspend");
    await lifecycle.warning();

    const contents = await readFile(join(files.root, TELEGRAM_POWER_STATE_FILE_NAME), "utf8");
    expect(contents).not.toContain("123456:secret-bot-token");
    expect(contents).not.toContain("athlete message");
    expect(JSON.parse(contents)).toEqual({
      schemaVersion: 2,
      athleteHome: files.athleteHome,
      gapStartedAt: "2026-08-01T00:00:00.000Z",
      lastSuccessfulPollAt: null,
      suspendedAt: "2026-08-01T00:00:00.000Z",
      warningDetectedAt: null,
    });
  });

  it("fails closed for malformed and wrong-home files, plus permissive POSIX files", async () => {
    const files = await fixture();
    const powerMonitor = monitor();
    const failures: string[] = [];
    let id = 0;
    const seed = createDesktopTelegramPowerLifecycle({
      ...files,
      powerMonitor,
      controller: controller(),
      now: () => Date.parse("2026-08-01T00:00:00.000Z"),
      createId: () => `state-${++id}`,
    });
    await seed.start();
    powerMonitor.emit("suspend");
    await seed.warning();
    await seed.close();
    const target = join(files.root, TELEGRAM_POWER_STATE_FILE_NAME);

    await writeFile(target, "{}\n", { mode: TELEGRAM_POWER_STATE_FILE_MODE });
    const malformed = createDesktopTelegramPowerLifecycle({
      ...files,
      powerMonitor: monitor(),
      controller: controller(),
      now: () => Date.parse("2026-08-02T00:00:00.000Z"),
      createId: () => `state-${++id}`,
      reportFailure: (failure) => failures.push(failure),
    });
    await expect(malformed.start()).resolves.toMatchObject({ state: "possible-message-loss" });
    await expect(malformed.acknowledgeWarning()).resolves.toEqual({ state: "clear" });
    await malformed.close();

    const wrongHomeRecord = {
      schemaVersion: 1,
      athleteHome: "/synthetic/other-athlete",
      suspendedAt: null,
      warningDetectedAt: null,
    };
    await writeFile(target, `${JSON.stringify(wrongHomeRecord)}\n`, { mode: 0o600 });
    const wrongHome = createDesktopTelegramPowerLifecycle({
      ...files,
      powerMonitor: monitor(),
      controller: controller(),
      now: () => Date.parse("2026-08-02T00:00:00.000Z"),
    });
    await expect(wrongHome.start()).resolves.toMatchObject({ state: "possible-message-loss" });
    await expect(wrongHome.acknowledgeWarning()).resolves.toMatchObject({
      state: "possible-message-loss",
    });
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual(wrongHomeRecord);
    await expect(wrongHome.resetForCreate()).resolves.toEqual({ state: "clear" });
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual({
      schemaVersion: 2,
      athleteHome: files.athleteHome,
      gapStartedAt: null,
      lastSuccessfulPollAt: null,
      suspendedAt: null,
      warningDetectedAt: null,
    });
    await wrongHome.close();

    if (process.platform !== "win32") {
      await chmod(target, 0o644);
      const permissive = createDesktopTelegramPowerLifecycle({
        ...files,
        powerMonitor: monitor(),
        controller: controller(),
        now: () => Date.parse("2026-08-02T00:00:00.000Z"),
      });
      await expect(permissive.start()).resolves.toMatchObject({ state: "possible-message-loss" });
      await expect(permissive.acknowledgeWarning()).resolves.toMatchObject({
        state: "possible-message-loss",
      });
    }
    expect(failures).toContain("read-state");
  });

  it("reopens Windows power state without POSIX ownership or directory sync", async () => {
    const files = await fixture();
    const observedAt = Date.parse("2026-08-01T00:00:00.000Z");
    const synchronizeDirectory = vi.fn(async () => {
      throw new TypeError("Windows directory sync must stay unavailable");
    });
    const synchronizeParentDirectory = vi.fn(async () => {
      throw new TypeError("Windows parent sync must stay unavailable");
    });
    const firstController = controller();
    firstController.status.mockResolvedValue(pollingStatus("online"));
    const lifecycle = createDesktopTelegramPowerLifecycle({
      ...files,
      platform: "win32",
      powerMonitor: monitor(),
      controller: firstController,
      now: () => observedAt,
      createId: () => "windows-power-state",
      syncDirectory: synchronizeDirectory,
      syncParentDirectory: synchronizeParentDirectory,
    });

    await expect(lifecycle.start()).resolves.toEqual({ state: "clear" });
    await lifecycle.close();
    const target = join(files.root, TELEGRAM_POWER_STATE_FILE_NAME);
    await chmod(files.root, 0o755);
    await chmod(target, 0o644);
    const secondController = controller();
    secondController.status.mockResolvedValue(pollingStatus("online"));
    secondController.resumePolling.mockResolvedValue(pollingStatus("online"));
    const secondMonitor = monitor();
    const reopened = createDesktopTelegramPowerLifecycle({
      ...files,
      platform: "win32",
      powerMonitor: secondMonitor,
      controller: secondController,
      now: () => observedAt,
      createId: () => "windows-power-reopen",
      syncDirectory: synchronizeDirectory,
      syncParentDirectory: synchronizeParentDirectory,
    });
    await expect(reopened.start()).resolves.toEqual({ state: "clear" });
    expect(JSON.parse(await readFile(target, "utf8"))).toMatchObject({
      schemaVersion: 2,
      athleteHome: files.athleteHome,
    });
    expect(synchronizeDirectory).not.toHaveBeenCalled();
    expect(synchronizeParentDirectory).not.toHaveBeenCalled();

    secondMonitor.emit("suspend");
    await reopened.warning();
    expect(secondController.stopPolling).toHaveBeenCalledOnce();
    secondMonitor.emit("resume");
    await reopened.warning();
    expect(secondController.stopPolling).toHaveBeenCalledTimes(2);
    expect(secondController.resumePolling).toHaveBeenCalledOnce();
    await reopened.close();
  });

  it("does not block suspend and still reconciles when stopping a stale poll fails", async () => {
    const files = await fixture();
    const powerMonitor = monitor();
    let now = Date.parse("2026-08-01T00:00:00.000Z");
    let releaseStop!: () => void;
    const blockedStop = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const telegram = {
      stopPolling: vi
        .fn<() => Promise<unknown>>()
        .mockImplementationOnce(() => blockedStop)
        .mockRejectedValueOnce(new Error("private transport detail")),
      resumePolling: vi.fn<() => Promise<unknown>>(async () => undefined),
      status: vi.fn<() => Promise<unknown>>(async () => undefined),
    };
    const failures: string[] = [];
    const lifecycle = createDesktopTelegramPowerLifecycle({
      ...files,
      powerMonitor,
      controller: telegram,
      now: () => now,
      createId: (() => {
        let id = 0;
        return () => `state-${++id}`;
      })(),
      reportFailure: (failure) => failures.push(failure),
    });
    await lifecycle.start();

    expect(powerMonitor.emit("suspend")).toBe(true);
    await vi.waitFor(() => expect(telegram.stopPolling).toHaveBeenCalledOnce());
    now += 1_000;
    expect(powerMonitor.emit("resume")).toBe(true);
    expect(telegram.resumePolling).not.toHaveBeenCalled();
    releaseStop();
    await lifecycle.warning();

    expect(telegram.stopPolling).toHaveBeenCalledTimes(2);
    expect(telegram.resumePolling).toHaveBeenCalledOnce();
    expect(failures).toContain("stop-polling");
  });

  it("removes both monitor listeners when closed", async () => {
    const files = await fixture();
    const powerMonitor = monitor();
    const telegram = controller();
    const lifecycle = createDesktopTelegramPowerLifecycle({
      ...files,
      powerMonitor,
      controller: telegram,
      createId: () => "close",
    });
    await lifecycle.start();
    expect(powerMonitor.listenerCount("suspend")).toBe(1);
    expect(powerMonitor.listenerCount("resume")).toBe(1);
    await lifecycle.close();
    expect(powerMonitor.listenerCount("suspend")).toBe(0);
    expect(powerMonitor.listenerCount("resume")).toBe(0);
    powerMonitor.emit("suspend");
    expect(telegram.stopPolling).not.toHaveBeenCalled();
  });

  it("fences suspend and resume callbacks queued behind work that was blocked before close", async () => {
    const files = await fixture();
    const powerMonitor = monitor();
    const telegram = controller();
    const blockedStatus = deferred<unknown>();
    telegram.status
      .mockResolvedValueOnce(pollingStatus("online", "2026-08-01T00:00:00.000Z"))
      .mockImplementationOnce(() => blockedStatus.promise)
      .mockResolvedValue(pollingStatus("online", "2026-08-01T00:00:00.000Z"));
    const lifecycle = createDesktopTelegramPowerLifecycle({
      ...files,
      powerMonitor,
      controller: telegram,
      now: () => Date.parse("2026-08-01T00:00:00.000Z"),
      createId: (() => {
        let id = 0;
        return () => `state-${++id}`;
      })(),
    });
    await lifecycle.start();

    const blockingOperation = lifecycle.warning();
    await vi.waitFor(() => expect(telegram.status).toHaveBeenCalledTimes(2));
    powerMonitor.emit("suspend");
    powerMonitor.emit("resume");
    const queueBarrier = lifecycle.warning();
    const closing = lifecycle.close();

    blockedStatus.resolve(pollingStatus("online", "2026-08-01T00:00:00.000Z"));
    await Promise.all([blockingOperation, queueBarrier, closing]);

    expect(telegram.stopPolling).not.toHaveBeenCalled();
    expect(telegram.resumePolling).not.toHaveBeenCalled();
  });

  it("balances an in-flight transient stop before close settles", async () => {
    const files = await fixture();
    const powerMonitor = monitor();
    const telegram = controller();
    const stopEntered = deferred<void>();
    const stopRelease = deferred<void>();
    const order: string[] = [];
    telegram.stopPolling.mockImplementationOnce(async () => {
      order.push("stop-started");
      stopEntered.resolve();
      await stopRelease.promise;
      order.push("stop-finished");
    });
    telegram.resumePolling.mockImplementationOnce(async () => {
      order.push("resumed");
    });
    const lifecycle = createDesktopTelegramPowerLifecycle({
      ...files,
      powerMonitor,
      controller: telegram,
      now: () => Date.parse("2026-08-01T00:00:00.000Z"),
      createId: (() => {
        let id = 0;
        return () => `state-${++id}`;
      })(),
    });
    await lifecycle.start();

    powerMonitor.emit("suspend");
    await stopEntered.promise;
    const closing = Promise.resolve(lifecycle.close()).then(() => {
      order.push("closed");
    });
    await Promise.resolve();
    expect(order).toEqual(["stop-started"]);

    stopRelease.resolve();
    await closing;

    expect(telegram.stopPolling).toHaveBeenCalledOnce();
    expect(telegram.resumePolling).toHaveBeenCalledOnce();
    expect(order).toEqual(["stop-started", "stop-finished", "resumed", "closed"]);
  });
});
