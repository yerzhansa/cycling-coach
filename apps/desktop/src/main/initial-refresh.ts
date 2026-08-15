import type { DesktopDaemonInitialRefreshConnection } from "@enduragent/coach/enduragent";
import type { DesktopDaemonConnection } from "./daemon-lifecycle.js";

type InitialRefreshConnection = Pick<
  DesktopDaemonConnection,
  "generation" | "url" | "token" | "owner"
>;

export interface DesktopInitialRefreshCoordinator {
  arm(connection: InitialRefreshConnection): void;
  prepareRecovery(input: {
    readonly current: InitialRefreshConnection;
    readonly rendererPresent: boolean;
  }): "reload-required" | "released";
  initialSetupStatusSettled(generation: number): Promise<void>;
  releaseCurrent(): Promise<void>;
}

export function shouldReleaseInitialRefreshAfterLoadFailure(
  errorCode: number,
  mainFrame: boolean,
): boolean {
  return mainFrame && errorCode !== -3;
}

export function createDesktopInitialRefreshCoordinator(input: {
  readonly currentConnection: () => InitialRefreshConnection;
  readonly startInitialRefresh: (
    connection: DesktopDaemonInitialRefreshConnection,
  ) => Promise<{ readonly status: "accepted" }>;
  readonly reportFailure: (error: unknown) => void;
  readonly scheduleRetry: (operation: () => void) => void;
}): DesktopInitialRefreshCoordinator {
  let armed:
    | {
        readonly connection: InitialRefreshConnection;
        releaseStarted: boolean;
        releaseTask?: Promise<void>;
      }
    | undefined;

  const sameConnection = (
    left: InitialRefreshConnection,
    right: InitialRefreshConnection,
  ): boolean =>
    left.generation === right.generation &&
    left.url === right.url &&
    left.token === right.token &&
    left.owner === right.owner;

  const release = (generation: number): Promise<void> => {
    const target = armed;
    if (target === undefined || target.connection.generation !== generation) {
      return Promise.resolve();
    }
    if (target.releaseStarted) return target.releaseTask ?? Promise.resolve();
    let current: InitialRefreshConnection;
    try {
      current = input.currentConnection();
    } catch {
      return Promise.resolve();
    }
    if (!sameConnection(target.connection, current)) return Promise.resolve();
    target.releaseStarted = true;
    const failed = (error: unknown): void => {
      input.reportFailure(error);
      if (armed !== target) return;
      target.releaseStarted = false;
      target.releaseTask = undefined;
      input.scheduleRetry(() => {
        if (armed === target) void release(generation);
      });
    };
    let request: Promise<{ readonly status: "accepted" }>;
    try {
      request = input.startInitialRefresh(current);
    } catch (error) {
      failed(error);
      return Promise.resolve();
    }
    target.releaseTask = request.then(
      () => {},
      failed,
    );
    return target.releaseTask;
  };

  const arm = (connection: InitialRefreshConnection): void => {
    if (!Number.isSafeInteger(connection.generation) || connection.generation < 1) {
      throw new TypeError("invalid desktop daemon generation");
    }
    if (armed !== undefined && sameConnection(armed.connection, connection)) return;
    armed = { connection, releaseStarted: false };
  };

  return {
    arm,
    prepareRecovery({ current, rendererPresent }) {
      arm(current);
      if (rendererPresent) return "reload-required";
      void release(current.generation);
      return "released";
    },
    initialSetupStatusSettled(generation) {
      if (!Number.isSafeInteger(generation) || generation < 1) {
        return Promise.reject(new TypeError("invalid desktop daemon generation"));
      }
      return release(generation);
    },
    releaseCurrent() {
      return armed === undefined ? Promise.resolve() : release(armed.connection.generation);
    },
  };
}
