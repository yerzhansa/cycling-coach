import { isAbsolute } from "node:path";
import { utilityProcess, type UtilityProcess } from "electron";
import {
  resolveDesktopDaemon,
  type AppSupervisedChildHandle,
  type DesktopDaemonResolution,
  type ResolveDesktopDaemonInput,
} from "@enduragent/coach/enduragent";
import { UTILITY_EXIT_TIMEOUT_MS } from "./constants.js";

export type UtilityStartFrame = {
  readonly type: "start";
  readonly homeRoot: string;
  readonly handoffCapability?: string;
};
export type UtilityShutdownFrame = { readonly type: "shutdown" };
export type UtilityTerminalAckFrame = { readonly type: "terminal-ack" };
export type UtilityTerminalFrame = {
  readonly type: "terminal";
  readonly exitCode: number;
};

export function isUtilityStartFrame(value: unknown): value is UtilityStartFrame {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    record.type !== "start" ||
    typeof record.homeRoot !== "string" ||
    !isAbsolute(record.homeRoot)
  ) {
    return false;
  }
  if (keys.length === 2) return keys[0] === "homeRoot" && keys[1] === "type";
  return (
    keys.length === 3 &&
    keys[0] === "handoffCapability" &&
    keys[1] === "homeRoot" &&
    keys[2] === "type" &&
    typeof record.handoffCapability === "string" &&
    /^[A-Za-z0-9_-]{43}$/.test(record.handoffCapability)
  );
}

export function isUtilityShutdownFrame(value: unknown): value is UtilityShutdownFrame {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    (value as { readonly type?: unknown }).type === "shutdown"
  );
}

export function isUtilityTerminalAckFrame(value: unknown): value is UtilityTerminalAckFrame {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    (value as { readonly type?: unknown }).type === "terminal-ack"
  );
}

export function isUtilityTerminalFrame(value: unknown): value is UtilityTerminalFrame {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 2 &&
    (value as { readonly type?: unknown }).type === "terminal" &&
    Number.isSafeInteger((value as { readonly exitCode?: unknown }).exitCode) &&
    (value as { readonly exitCode: number }).exitCode >= 0
  );
}

export function createUtilityEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment = { ...source };
  delete environment.ENDURAGENT_HOME;
  delete environment.ENDURAGENT_DAEMON_OWNER;
  delete environment.ENDURAGENT_HANDOFF_CAPABILITY;
  delete environment.ENDURAGENT_STARTER_CONTEXT_FD;
  return environment;
}

function waitForSpawn(child: UtilityProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      child.off("spawn", onSpawn);
      child.off("exit", onEarlyExit);
    };
    const onSpawn = (): void => {
      cleanup();
      resolve();
    };
    const onEarlyExit = (): void => {
      cleanup();
      reject(new Error("utility process exited before spawn"));
    };
    child.once("spawn", onSpawn);
    child.once("exit", onEarlyExit);
  });
}

function waitWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(undefined);
    }, timeoutMs);
    void promise.then((value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    });
  });
}

export async function forkAppSupervisedDaemon(input: {
  readonly utilityEntry: string;
  readonly homeRoot: string;
  readonly handoffCapability?: string;
}): Promise<AppSupervisedChildHandle> {
  const start = {
    type: "start",
    homeRoot: input.homeRoot,
    ...(input.handoffCapability === undefined
      ? {}
      : { handoffCapability: input.handoffCapability }),
  } satisfies UtilityStartFrame;
  if (!isAbsolute(input.utilityEntry) || !isUtilityStartFrame(start)) {
    throw new TypeError("utility paths must be absolute");
  }
  const child = utilityProcess.fork(input.utilityEntry, [], {
    serviceName: "enduragent serve",
    stdio: "ignore",
    env: createUtilityEnvironment(),
  });
  let exitCode: number | null = null;
  let exited = false;
  let resolveExited!: (value: { readonly exitCode: number | null }) => void;
  const exitedPromise = new Promise<{ readonly exitCode: number | null }>((resolve) => {
    resolveExited = resolve;
  });
  child.once("exit", (code) => {
    exited = true;
    exitCode = Number.isInteger(code) ? code : null;
    resolveExited({ exitCode });
  });
  child.on("message", (message) => {
    if (isUtilityTerminalFrame(message)) {
      child.postMessage({ type: "terminal-ack" } satisfies UtilityTerminalAckFrame);
    }
  });
  try {
    await waitForSpawn(child);
    child.postMessage(start);
  } catch (error) {
    child.kill();
    await exitedPromise;
    throw error;
  }
  const pid = child.pid;
  if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) {
    child.kill();
    await exitedPromise;
    throw new Error("utility process did not publish a pid");
  }
  let stopPromise: Promise<void> | undefined;
  return {
    pid,
    exited: exitedPromise,
    stop() {
      stopPromise ??= (async () => {
        if (!exited) {
          child.postMessage({ type: "shutdown" } satisfies UtilityShutdownFrame);
          if ((await waitWithTimeout(exitedPromise, UTILITY_EXIT_TIMEOUT_MS)) === undefined) {
            child.kill();
          }
        }
        await exitedPromise;
      })();
      return stopPromise;
    },
  };
}

export class DesktopDaemonSupervisor {
  private active: Promise<DesktopDaemonResolution> | undefined;

  constructor(
    private readonly input: Omit<ResolveDesktopDaemonInput, "startAppSupervisedDaemon">,
    private readonly utilityEntry: string,
    private readonly resolveDaemon: typeof resolveDesktopDaemon = resolveDesktopDaemon,
  ) {}

  resolve(): Promise<DesktopDaemonResolution> {
    if (this.active !== undefined) return this.active;
    const generation = this.resolveDaemon({
      ...this.input,
      startAppSupervisedDaemon: ({ home, handoffCapability }) =>
        forkAppSupervisedDaemon({
          utilityEntry: this.utilityEntry,
          homeRoot: home.root,
          ...(handoffCapability === undefined ? {} : { handoffCapability }),
        }),
    })
      .then((resolution) => {
        if (resolution.status === "refused") {
          if (this.active === generation) this.active = undefined;
          return resolution;
        }
        let closePromise: Promise<void> | undefined;
        return {
          ...resolution,
          close: () => {
            closePromise ??= resolution.close().finally(() => {
              if (this.active === generation) this.active = undefined;
            });
            return closePromise;
          },
        };
      })
      .catch((error) => {
        if (this.active === generation) this.active = undefined;
        throw error;
      });
    this.active = generation;
    return generation;
  }

  async close(): Promise<void> {
    const active = this.active;
    if (active === undefined) return;
    const resolution = await active;
    if (resolution.status === "connected") await resolution.close();
  }
}
