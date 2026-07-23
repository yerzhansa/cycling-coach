import { isStableCalVer, isUpdateAvailable } from "@enduragent/core";
import type { AppUpdater, UpdateDownloadedEvent } from "electron-updater";

export type DesktopUpdateState =
  | { readonly status: "disabled" }
  | { readonly status: "idle" }
  | { readonly status: "checking" }
  | { readonly status: "current" }
  | { readonly status: "downloading"; readonly version: string }
  | { readonly status: "downloaded"; readonly version: string }
  | { readonly status: "installing"; readonly version: string }
  | { readonly status: "failed"; readonly stage: "check" | "download" };

export type DesktopAutoUpdater = Pick<
  AppUpdater,
  | "logger"
  | "autoDownload"
  | "autoInstallOnAppQuit"
  | "allowPrerelease"
  | "allowDowngrade"
  | "on"
  | "off"
  | "checkForUpdates"
  | "downloadUpdate"
  | "quitAndInstall"
>;

export interface DesktopUpdateController {
  readonly state: () => DesktopUpdateState;
  readonly start: () => Promise<void>;
  readonly check: () => Promise<DesktopUpdateState>;
  readonly restart: () => DesktopUpdateState;
  readonly subscribe: (listener: (state: DesktopUpdateState) => void) => () => void;
  readonly completeInstallAfterDrain: (
    allowFinalQuit: () => void,
  ) => "started" | "not-requested" | "failed";
  readonly close: () => void;
}

interface TimerHandle {
  unref(): void;
}

export const DESKTOP_UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1_000;

export function copyDesktopUpdateState(state: DesktopUpdateState): DesktopUpdateState {
  if ("version" in state) return { status: state.status, version: state.version };
  if (state.status === "failed") return { status: "failed", stage: state.stage };
  return { status: state.status };
}

export function createDesktopUpdateController(input: {
  readonly releaseEligible: boolean;
  readonly currentVersion: string;
  readonly loadUpdater: () => Promise<DesktopAutoUpdater>;
  readonly requestQuit: () => void;
  readonly setInterval?: (callback: () => void, interval: number) => TimerHandle;
  readonly clearInterval?: (handle: TimerHandle) => void;
}): DesktopUpdateController {
  const active = input.releaseEligible;
  const listeners = new Set<(state: DesktopUpdateState) => void>();
  const schedule =
    input.setInterval ??
    ((callback, interval) => globalThis.setInterval(callback, interval) as TimerHandle);
  const unschedule =
    input.clearInterval ??
    ((handle) => globalThis.clearInterval(handle as ReturnType<typeof globalThis.setInterval>));
  let state: DesktopUpdateState = active ? { status: "idle" } : { status: "disabled" };
  let updater: DesktopAutoUpdater | undefined;
  let timer: TimerHandle | undefined;
  let started = false;
  let closed = false;
  let activeCheck: Promise<DesktopUpdateState> | undefined;
  let targetVersion: string | undefined;
  let installRequested = false;
  let installInvoked = false;
  let errorListenerInstalled = false;
  let downloadedListenerInstalled = false;

  const publish = (next: DesktopUpdateState): void => {
    if (closed) return;
    state = copyDesktopUpdateState(next);
    for (const listener of listeners) {
      try {
        listener(copyDesktopUpdateState(state));
      } catch {}
    }
  };

  const onError = (): void => {
    if (closed) return;
    if (state.status === "downloading") {
      targetVersion = undefined;
      publish({ status: "failed", stage: "download" });
    } else if (state.status === "checking") {
      targetVersion = undefined;
      publish({ status: "failed", stage: "check" });
    }
  };
  const onDownloaded = (event: UpdateDownloadedEvent): void => {
    if (
      closed ||
      state.status !== "downloading" ||
      targetVersion === undefined ||
      event.version !== targetVersion
    ) {
      if (!closed && state.status === "downloading") {
        targetVersion = undefined;
        publish({ status: "failed", stage: "download" });
      }
      return;
    }
    publish({ status: "downloaded", version: targetVersion });
  };

  const canCheck = (): boolean =>
    !closed && active && !["downloading", "downloaded", "installing"].includes(state.status);
  const currentState = (): DesktopUpdateState => state;
  const removeUpdaterListeners = (): void => {
    if (updater === undefined) return;
    if (errorListenerInstalled) {
      try {
        updater.off("error", onError);
      } catch {}
      errorListenerInstalled = false;
    }
    if (downloadedListenerInstalled) {
      try {
        updater.off("update-downloaded", onDownloaded);
      } catch {}
      downloadedListenerInstalled = false;
    }
  };

  const check = (): Promise<DesktopUpdateState> => {
    if (activeCheck !== undefined) return activeCheck;
    if (!canCheck() || updater === undefined) return Promise.resolve(copyDesktopUpdateState(state));
    publish({ status: "checking" });
    const pending = updater
      .checkForUpdates()
      .then(async (result) => {
        if (closed || state.status !== "checking") return copyDesktopUpdateState(state);
        const version = result?.updateInfo.version;
        if (
          result?.isUpdateAvailable !== true ||
          !isStableCalVer(version) ||
          !isUpdateAvailable(version, input.currentVersion)
        ) {
          targetVersion = undefined;
          publish({ status: "current" });
          return copyDesktopUpdateState(state);
        }
        targetVersion = version;
        publish({ status: "downloading", version });
        try {
          await updater!.downloadUpdate();
        } catch {
          if (!closed && currentState().status === "downloading") {
            targetVersion = undefined;
            publish({ status: "failed", stage: "download" });
          }
        }
        return copyDesktopUpdateState(state);
      })
      .catch(() => {
        if (!closed && state.status === "checking") {
          targetVersion = undefined;
          publish({ status: "failed", stage: "check" });
        }
        return copyDesktopUpdateState(state);
      })
      .finally(() => {
        if (activeCheck === pending) activeCheck = undefined;
      });
    activeCheck = pending;
    return pending;
  };

  const start = async (): Promise<void> => {
    if (started || closed || !active) return;
    started = true;
    try {
      updater = await input.loadUpdater();
    } catch {
      if (!closed) publish({ status: "failed", stage: "check" });
      return;
    }
    if (closed) return;
    try {
      updater.logger = null;
      updater.autoDownload = false;
      updater.autoInstallOnAppQuit = false;
      updater.allowPrerelease = false;
      updater.allowDowngrade = false;
      updater.on("error", onError);
      errorListenerInstalled = true;
      updater.on("update-downloaded", onDownloaded);
      downloadedListenerInstalled = true;
      await check();
      if (closed) return;
      timer = schedule(() => {
        void check();
      }, DESKTOP_UPDATE_INTERVAL_MS);
      timer.unref();
    } catch {
      if (timer !== undefined) {
        try {
          unschedule(timer);
        } catch {}
        timer = undefined;
      }
      removeUpdaterListeners();
      if (!closed) publish({ status: "failed", stage: "check" });
    }
  };

  return {
    state: () => copyDesktopUpdateState(state),
    start,
    check,
    restart() {
      if (closed || state.status !== "downloaded" || installRequested) {
        return copyDesktopUpdateState(state);
      }
      installRequested = true;
      publish({ status: "installing", version: state.version });
      input.requestQuit();
      return copyDesktopUpdateState(state);
    },
    subscribe(listener) {
      if (closed) return () => {};
      if (active) listeners.add(listener);
      try {
        listener(copyDesktopUpdateState(state));
      } catch {}
      return active ? () => listeners.delete(listener) : () => {};
    },
    completeInstallAfterDrain(allowFinalQuit) {
      if (!installRequested || updater === undefined) return "not-requested";
      if (installInvoked) return "started";
      installInvoked = true;
      try {
        allowFinalQuit();
        updater.quitAndInstall(false, true);
        return "started";
      } catch {
        return "failed";
      }
    },
    close() {
      if (closed) return;
      closed = true;
      if (timer !== undefined) {
        try {
          unschedule(timer);
        } catch {}
        timer = undefined;
      }
      removeUpdaterListeners();
      targetVersion = undefined;
      listeners.clear();
    },
  };
}
