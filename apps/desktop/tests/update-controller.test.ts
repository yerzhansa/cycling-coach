import { describe, expect, it, vi } from "vitest";
import {
  createDesktopUpdateController,
  DESKTOP_UPDATE_INTERVAL_MS,
  type DesktopAutoUpdater,
} from "../src/main/update-controller.js";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function updateResult(version: string, isUpdateAvailable = true) {
  return { isUpdateAvailable, updateInfo: { version } } as never;
}

function fakeUpdater() {
  const listeners = new Map<string, Set<(...args: never[]) => void>>();
  const updater = {
    logger: {} as unknown,
    autoDownload: true,
    autoInstallOnAppQuit: true,
    autoRunAppAfterInstall: false,
    allowPrerelease: true,
    allowDowngrade: true,
    checkForUpdates: vi.fn<DesktopAutoUpdater["checkForUpdates"]>(),
    downloadUpdate: vi.fn<DesktopAutoUpdater["downloadUpdate"]>(async () => []),
    quitAndInstall: vi.fn(),
    on: vi.fn((event: string, listener: (...args: never[]) => void) => {
      const handlers = listeners.get(event) ?? new Set();
      handlers.add(listener);
      listeners.set(event, handlers);
      return updater;
    }),
    off: vi.fn((event: string, listener: (...args: never[]) => void) => {
      listeners.get(event)?.delete(listener);
      return updater;
    }),
  };
  return {
    updater: updater as unknown as DesktopAutoUpdater,
    emit(event: string, value: unknown) {
      for (const listener of listeners.get(event) ?? []) listener(value as never);
    },
    listenerCount: () => [...listeners.values()].reduce((sum, handlers) => sum + handlers.size, 0),
  };
}

function activeController(
  updater: DesktopAutoUpdater,
  overrides: Partial<Parameters<typeof createDesktopUpdateController>[0]> = {},
) {
  const quit = vi.fn();
  const timer = { unref: vi.fn() };
  let tick: (() => void) | undefined;
  const clearInterval = vi.fn();
  const controller = createDesktopUpdateController({
    releaseEligible: true,
    currentVersion: "2026.7.22",
    loadUpdater: vi.fn(async () => updater),
    requestQuit: quit,
    setInterval: vi.fn((callback, interval) => {
      expect(interval).toBe(DESKTOP_UPDATE_INTERVAL_MS);
      tick = callback;
      return timer;
    }),
    clearInterval,
    ...overrides,
  });
  return { clearInterval, controller, quit, timer, tick: () => tick?.() };
}

describe("desktop update controller", () => {
  it("is silent when release eligibility is disabled", async () => {
    const loadUpdater = vi.fn();
    const setInterval = vi.fn();
    const controller = createDesktopUpdateController({
      releaseEligible: false,
      currentVersion: "2026.7.22",
      loadUpdater,
      requestQuit: vi.fn(),
      setInterval,
    });

    await controller.start();
    await controller.check();

    expect(controller.state()).toEqual({ status: "disabled" });
    expect(loadUpdater).not.toHaveBeenCalled();
    expect(setInterval).not.toHaveBeenCalled();
  });

  it("configures a quiet updater, performs startup and unref'd daily checks, and cleans up", async () => {
    const fake = fakeUpdater();
    vi.mocked(fake.updater.checkForUpdates).mockResolvedValue(updateResult("2026.7.22"));
    const subject = activeController(fake.updater);

    await subject.controller.start();

    expect(fake.updater).toMatchObject({
      logger: null,
      autoDownload: false,
      autoInstallOnAppQuit: false,
      autoRunAppAfterInstall: true,
      allowPrerelease: false,
      allowDowngrade: false,
    });
    expect(fake.updater.checkForUpdates).toHaveBeenCalledOnce();
    expect(subject.timer.unref).toHaveBeenCalledOnce();
    expect(fake.listenerCount()).toBe(2);
    subject.tick();
    await vi.waitFor(() => expect(fake.updater.checkForUpdates).toHaveBeenCalledTimes(2));
    subject.controller.close();
    subject.controller.close();
    expect(subject.clearInterval).toHaveBeenCalledOnce();
    expect(fake.listenerCount()).toBe(0);
  });

  it("coalesces concurrent checks and retries after settlement", async () => {
    const fake = fakeUpdater();
    const first = deferred<never>();
    vi.mocked(fake.updater.checkForUpdates)
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(updateResult("2026.7.22"));
    const subject = activeController(fake.updater);
    const startup = subject.controller.start();
    await vi.waitFor(() => expect(fake.updater.checkForUpdates).toHaveBeenCalledOnce());

    const concurrent = subject.controller.check();
    first.resolve(updateResult("2026.7.22"));
    await expect(concurrent).resolves.toEqual({ status: "current" });
    await startup;
    await subject.controller.check();
    expect(fake.updater.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it("downloads only a strictly newer stable target and accepts only its exact event", async () => {
    const fake = fakeUpdater();
    vi.mocked(fake.updater.checkForUpdates).mockResolvedValue(updateResult("2026.7.23"));
    const subject = activeController(fake.updater);
    await subject.controller.start();

    expect(fake.updater.downloadUpdate).toHaveBeenCalledOnce();
    expect(subject.controller.state()).toEqual({
      status: "downloading",
      version: "2026.7.23",
    });
    expect(subject.quit).not.toHaveBeenCalled();
    fake.emit("update-downloaded", { version: "2026.7.23", downloadedFile: "/private/raw.zip" });
    expect(subject.controller.state()).toEqual({
      status: "downloaded",
      version: "2026.7.23",
    });
    expect(JSON.stringify(subject.controller.state())).not.toContain("raw.zip");
  });

  it.each([
    "2026.7.22",
    "2026.7.21",
    "2026.7.23-beta.1",
    "2026.0.23",
    "2026.13.23",
    "2026.7.9007199254740992",
    "999.7.23",
    "10000.7.23",
    "not-a-version",
  ])("refuses non-newer or non-stable target %s", async (version) => {
    const fake = fakeUpdater();
    vi.mocked(fake.updater.checkForUpdates).mockResolvedValue(updateResult(version));
    const subject = activeController(fake.updater);
    await subject.controller.start();
    expect(subject.controller.state()).toEqual({ status: "current" });
    expect(fake.updater.downloadUpdate).not.toHaveBeenCalled();
  });

  it("clears a failed candidate when the updater reports a newer version unavailable", async () => {
    const fake = fakeUpdater();
    vi.mocked(fake.updater.checkForUpdates)
      .mockResolvedValueOnce(updateResult("2026.7.23"))
      .mockResolvedValueOnce(updateResult("2026.7.24", false));
    vi.mocked(fake.updater.downloadUpdate).mockRejectedValueOnce(
      new Error("synthetic download failure"),
    );
    const subject = activeController(fake.updater);

    await subject.controller.start();
    expect(subject.controller.state()).toEqual({ status: "failed", stage: "download" });
    await subject.controller.check();

    expect(subject.controller.state()).toEqual({ status: "current" });
    expect(fake.updater.downloadUpdate).toHaveBeenCalledOnce();
    fake.emit("update-downloaded", { version: "2026.7.23" });
    expect(subject.controller.state()).toEqual({ status: "current" });
  });

  it("fails closed on a mismatched downloaded event and contains updater diagnostics", async () => {
    const fake = fakeUpdater();
    vi.mocked(fake.updater.checkForUpdates).mockResolvedValue(updateResult("2026.7.23"));
    const states: unknown[] = [];
    const subject = activeController(fake.updater);
    subject.controller.subscribe((state) => states.push(state));
    await subject.controller.start();
    fake.emit("update-downloaded", {
      version: "2026.7.24",
      downloadedFile: "/Users/athlete/private/update.zip",
    });
    fake.emit("error", new Error("Authorization: secret"));

    expect(subject.controller.state()).toEqual({ status: "failed", stage: "download" });
    expect(JSON.stringify(states)).not.toContain("private/update");
    expect(JSON.stringify(states)).not.toContain("Authorization");
  });

  it("requests an explicit quit only after download and installs once after a successful drain", async () => {
    const fake = fakeUpdater();
    vi.mocked(fake.updater.checkForUpdates).mockResolvedValue(updateResult("2026.7.23"));
    const subject = activeController(fake.updater);
    await subject.controller.start();

    expect(subject.controller.restart()).toEqual({
      status: "downloading",
      version: "2026.7.23",
    });
    fake.emit("update-downloaded", { version: "2026.7.23" });
    expect(subject.controller.restart()).toEqual({
      status: "installing",
      version: "2026.7.23",
    });
    subject.controller.restart();
    expect(subject.quit).toHaveBeenCalledOnce();
    expect(fake.updater.quitAndInstall).not.toHaveBeenCalled();

    const allowFinalQuit = vi.fn();
    subject.controller.close();
    expect(subject.controller.completeInstallAfterDrain(allowFinalQuit)).toBe("started");
    expect(subject.controller.completeInstallAfterDrain(allowFinalQuit)).toBe("started");
    expect(allowFinalQuit).toHaveBeenCalledOnce();
    expect(fake.updater.quitAndInstall).toHaveBeenCalledOnce();
    expect(fake.updater.quitAndInstall).toHaveBeenCalledWith(false, true);
    expect(allowFinalQuit.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(fake.updater.quitAndInstall).mock.invocationCallOrder[0]!,
    );
  });

  it("does not install on ordinary quit or failed download", async () => {
    const fake = fakeUpdater();
    vi.mocked(fake.updater.checkForUpdates).mockRejectedValue(
      new Error("https://private.invalid/feed"),
    );
    const subject = activeController(fake.updater);
    await subject.controller.start();
    expect(subject.controller.state()).toEqual({ status: "failed", stage: "check" });
    expect(subject.controller.completeInstallAfterDrain(vi.fn())).toBe("not-requested");
    expect(fake.updater.quitAndInstall).not.toHaveBeenCalled();
  });
});
