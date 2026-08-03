import { EventEmitter } from "node:events";
import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

function monitor(): EventEmitter & TelegramPowerMonitorPort {
  return new EventEmitter() as EventEmitter & TelegramPowerMonitorPort;
}

function controller() {
  return {
    stopPolling: vi.fn(async () => undefined),
    reconcile: vi.fn(async () => undefined),
  };
}

describe("Desktop Telegram power lifecycle", () => {
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
    expect(telegram.reconcile).not.toHaveBeenCalled();

    const target = join(files.root, TELEGRAM_POWER_STATE_FILE_NAME);
    expect((await lstat(files.root)).mode & 0o777).toBe(TELEGRAM_POWER_STATE_DIRECTORY_MODE);
    expect((await lstat(target)).mode & 0o777).toBe(TELEGRAM_POWER_STATE_FILE_MODE);
    const suspended = JSON.parse(await readFile(target, "utf8"));
    expect(suspended).toEqual({
      schemaVersion: 1,
      athleteHome: files.athleteHome,
      suspendedAt: "2026-08-01T00:00:00.000Z",
      warningDetectedAt: null,
    });
    expect(Object.keys(suspended).sort()).toEqual([
      "athleteHome",
      "schemaVersion",
      "suspendedAt",
      "warningDetectedAt",
    ]);

    now += TELEGRAM_POSSIBLE_MESSAGE_LOSS_AFTER_MS - 1;
    expect(powerMonitor.emit("resume")).toBe(true);
    await expect(lifecycle.warning()).resolves.toEqual({ state: "clear" });
    expect(telegram.stopPolling).toHaveBeenCalledTimes(2);
    expect(telegram.reconcile).toHaveBeenCalledOnce();
    expect(JSON.parse(await readFile(target, "utf8"))).toMatchObject({
      suspendedAt: null,
      warningDetectedAt: null,
    });
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
    first.close();

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
    expect(recoveredController.reconcile).toHaveBeenCalledOnce();
    recovered.close();

    const restarted = createDesktopTelegramPowerLifecycle({
      ...files,
      powerMonitor: monitor(),
      controller: controller(),
      now: () => now,
      createId: () => `state-${++ids}`,
    });
    await expect(restarted.start()).resolves.toEqual(expectedWarning);
    await expect(restarted.acknowledgeWarning()).resolves.toEqual({ state: "clear" });
    restarted.close();

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
      schemaVersion: 1,
      athleteHome: files.athleteHome,
      suspendedAt: "2026-08-01T00:00:00.000Z",
      warningDetectedAt: null,
    });
  });

  it("fails closed for malformed, wrong-home, and permissive state files", async () => {
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
    seed.close();
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
    malformed.close();

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
    wrongHome.close();

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
    expect(failures).toContain("read-state");
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
      reconcile: vi.fn(async () => undefined),
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
    expect(telegram.reconcile).not.toHaveBeenCalled();
    releaseStop();
    await lifecycle.warning();

    expect(telegram.stopPolling).toHaveBeenCalledTimes(2);
    expect(telegram.reconcile).toHaveBeenCalledOnce();
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
    lifecycle.close();
    expect(powerMonitor.listenerCount("suspend")).toBe(0);
    expect(powerMonitor.listenerCount("resume")).toBe(0);
    powerMonitor.emit("suspend");
    expect(telegram.stopPolling).not.toHaveBeenCalled();
  });
});
