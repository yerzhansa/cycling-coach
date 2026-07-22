import { isAbsolute } from "node:path";
import { utilityProcess, type UtilityProcess } from "electron";
import {
  AppSupervisedDaemonStartError,
  resolveDesktopDaemon,
  type AppSupervisedChildHandle,
  type DesktopDaemonStartBudget,
  type DesktopDaemonResolution,
  type ResolveDesktopDaemonInput,
} from "@enduragent/coach/enduragent";
import type { DesktopDaemonRecoveryBudget } from "./daemon-lifecycle.js";
import {
  UTILITY_EXIT_TIMEOUT_MS,
  UTILITY_FORCE_EXIT_TIMEOUT_MS,
  UTILITY_SPAWN_TIMEOUT_MS,
} from "./constants.js";

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

function waitForSpawn(child: UtilityProcess, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => finish(new Error("utility process spawn deadline exceeded")),
      UTILITY_SPAWN_TIMEOUT_MS,
    );
    const cleanup = (): void => {
      clearTimeout(timer);
      child.off("spawn", onSpawn);
      child.off("exit", onEarlyExit);
      signal.removeEventListener("abort", onAbort);
    };
    const finish = (error?: Error): void => {
      cleanup();
      if (error === undefined) resolve();
      else reject(error);
    };
    const onSpawn = (): void => {
      finish();
    };
    const onEarlyExit = (): void => {
      finish(new Error("utility process exited before spawn"));
    };
    const onAbort = (): void => finish(new Error("utility process spawn cancelled"));
    child.once("spawn", onSpawn);
    child.once("exit", onEarlyExit);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
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
    void promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
}

export async function terminateOwnedUtilityProcess(input: {
  readonly child: Pick<UtilityProcess, "postMessage" | "kill">;
  readonly pid: number;
  readonly exited: Promise<{ readonly exitCode: number | null }>;
  readonly hasExited: () => boolean;
  readonly hardStop?: (pid: number) => void;
}): Promise<void> {
  if (input.hasExited()) return;
  try {
    input.child.postMessage({ type: "shutdown" } satisfies UtilityShutdownFrame);
  } catch {}
  if ((await waitWithTimeout(input.exited, UTILITY_EXIT_TIMEOUT_MS)) !== undefined) return;
  input.child.kill();
  if ((await waitWithTimeout(input.exited, UTILITY_FORCE_EXIT_TIMEOUT_MS)) !== undefined) return;
  if (!Number.isSafeInteger(input.pid) || input.pid <= 0) {
    throw new Error("utility process owned pid is invalid");
  }
  try {
    (input.hardStop ?? ((pid) => process.kill(pid, "SIGKILL")))(input.pid);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    throw error;
  }
  if ((await waitWithTimeout(input.exited, UTILITY_FORCE_EXIT_TIMEOUT_MS)) === undefined) {
    throw new Error("utility process termination deadline exceeded");
  }
}

async function terminateUnacknowledgedUtility(
  child: UtilityProcess,
  exited: Promise<{ readonly exitCode: number | null }>,
): Promise<void> {
  child.kill();
  if ((await waitWithTimeout(exited, UTILITY_FORCE_EXIT_TIMEOUT_MS)) !== undefined) return;
  const pid = child.pid;
  if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error("unacknowledged utility process could not be reaped");
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    throw error;
  }
  if ((await waitWithTimeout(exited, UTILITY_FORCE_EXIT_TIMEOUT_MS)) === undefined) {
    throw new Error("unacknowledged utility process termination deadline exceeded");
  }
}

export async function forkAppSupervisedDaemon(input: {
  readonly utilityEntry: string;
  readonly homeRoot: string;
  readonly handoffCapability?: string;
  readonly signal?: AbortSignal;
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
    await waitForSpawn(child, input.signal ?? new AbortController().signal);
    child.postMessage(start);
  } catch {
    try {
      await terminateUnacknowledgedUtility(child, exitedPromise);
    } catch {
      throw new AppSupervisedDaemonStartError("termination-failed");
    }
    throw new AppSupervisedDaemonStartError("spawn-failed");
  }
  const pid = child.pid;
  if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) {
    try {
      await terminateUnacknowledgedUtility(child, exitedPromise);
    } catch {
      throw new AppSupervisedDaemonStartError("termination-failed");
    }
    throw new AppSupervisedDaemonStartError("spawn-failed");
  }
  let stopPromise: Promise<void> | undefined;
  return {
    pid,
    exited: exitedPromise,
    isAlive: () => !exited,
    stop() {
      stopPromise ??= terminateOwnedUtilityProcess({
        child,
        pid,
        exited: exitedPromise,
        hasExited: () => exited,
      });
      return stopPromise;
    },
  };
}

export class DesktopDaemonSupervisor {
  private active: Promise<DesktopDaemonResolution> | undefined;
  private closing = false;

  constructor(
    private readonly input: Omit<ResolveDesktopDaemonInput, "startAppSupervisedDaemon">,
    private readonly utilityEntry: string,
    private readonly resolveDaemon: typeof resolveDesktopDaemon = resolveDesktopDaemon,
  ) {}

  resolve(): Promise<DesktopDaemonResolution> {
    if (this.active !== undefined) return this.active;
    return this.beginResolve();
  }

  resolveForRecovery(budget: DesktopDaemonRecoveryBudget): Promise<DesktopDaemonResolution> {
    this.active = undefined;
    return this.beginResolve(budget);
  }

  reobserveAttached(budget: DesktopDaemonRecoveryBudget): Promise<DesktopDaemonResolution> {
    this.active = undefined;
    return this.beginResolve(budget, true);
  }

  private beginResolve(
    startBudget?: DesktopDaemonStartBudget,
    observationOnly = false,
  ): Promise<DesktopDaemonResolution> {
    const generation = this.resolveDaemon({
      ...this.input,
      ...(startBudget === undefined ? {} : { startBudget }),
      ...(observationOnly ? { observationOnly: true } : {}),
      startAppSupervisedDaemon: ({ home, handoffCapability }) =>
        forkAppSupervisedDaemon({
          utilityEntry: this.utilityEntry,
          homeRoot: home.root,
          signal: this.input.signal,
          ...(handoffCapability === undefined ? {} : { handoffCapability }),
        }),
    })
      .then(async (resolution) => {
        if (resolution.status === "refused") {
          if (this.active === generation) this.active = undefined;
          return resolution;
        }
        let closePromise: Promise<void> | undefined;
        const wrapped = {
          ...resolution,
          close: () => {
            closePromise ??= resolution.close().finally(() => {
              if (this.active === generation) this.active = undefined;
            });
            return closePromise;
          },
        };
        if (this.closing) {
          await wrapped.close().catch(() => {});
          return {
            status: "refused" as const,
            exitCode: 3 as const,
            classification: "contention-family" as const,
            cause: "cancelled" as const,
            retryable: true,
          };
        }
        return wrapped;
      })
      .catch((error) => {
        if (this.active === generation) this.active = undefined;
        throw error;
      });
    this.active = generation;
    return generation;
  }

  async close(): Promise<void> {
    this.closing = true;
    const active = this.active;
    if (active === undefined) return;
    const closing = active.then(async (resolution) => {
      if (resolution.status === "connected") await resolution.close();
    });
    await waitWithTimeout(closing, UTILITY_EXIT_TIMEOUT_MS + UTILITY_FORCE_EXIT_TIMEOUT_MS * 2);
  }
}
