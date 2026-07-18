import { EXIT_SUCCESS, type ExitCode } from "@enduragent/coach-contract";
import type { AthleteHome } from "@enduragent/kernel-node/home";
import { createHealthzRequestHandler } from "./daemon/healthz-server.js";
import { createCoachRpcServer, ensureDaemonToken } from "./daemon/rpc-server.js";
import type { LocalCoachLifecycle } from "./local-runner.js";

export interface RunCoachServeInput {
  readonly lifecycle: LocalCoachLifecycle;
  readonly home: AthleteHome;
  readonly appVersion: string;
  readonly signal: AbortSignal;
}

export interface CoachServeDependencies {
  readonly ensureToken: typeof ensureDaemonToken;
  readonly createRpcServer: typeof createCoachRpcServer;
  readonly createHealthzHandler: typeof createHealthzRequestHandler;
}

const defaultDependencies: CoachServeDependencies = {
  ensureToken: ensureDaemonToken,
  createRpcServer: createCoachRpcServer,
  createHealthzHandler: createHealthzRequestHandler,
};

export async function runCoachServe(
  input: RunCoachServeInput,
  dependencies: CoachServeDependencies = defaultDependencies,
): Promise<ExitCode> {
  if (input.signal.aborted) return EXIT_SUCCESS;
  let aborted = false;
  let resolveAbort!: () => void;
  const abortPromise = new Promise<void>((resolve) => {
    resolveAbort = resolve;
  });
  const latchAbort = (): void => {
    if (aborted) return;
    aborted = true;
    resolveAbort();
  };
  input.signal.addEventListener("abort", latchAbort, { once: true });
  if (input.signal.aborted) latchAbort();
  try {
    if (aborted) return EXIT_SUCCESS;
    const token = await dependencies.ensureToken(input.home.configDir);
    if (aborted) return EXIT_SUCCESS;
    const rpc = dependencies.createRpcServer({
      engine: input.lifecycle.engine,
      token: token.value,
      owner: "unmanaged-foreground",
    });
    if (aborted) {
      await rpc.close();
      return EXIT_SUCCESS;
    }
    let binding: Awaited<ReturnType<LocalCoachLifecycle["listener"]["bind"]>>;
    try {
      binding = await input.lifecycle.listener.bind({
        request: dependencies.createHealthzHandler({
          appVersion: input.appVersion,
          owner: "unmanaged-foreground",
        }),
        upgrade: rpc.handleUpgrade,
      });
    } catch (error) {
      await rpc.close().catch(() => {});
      throw error;
    }
    if (!aborted) await abortPromise;
    let bindingClose: Promise<void>;
    try {
      bindingClose = binding.close();
    } catch (error) {
      await rpc.close().catch(() => {});
      throw error;
    }
    let cleanupError: unknown;
    try {
      await rpc.close();
    } catch (error) {
      cleanupError = error;
    }
    try {
      await bindingClose;
    } catch (error) {
      cleanupError ??= error;
    }
    if (cleanupError !== undefined) throw cleanupError;
    return EXIT_SUCCESS;
  } finally {
    input.signal.removeEventListener("abort", latchAbort);
  }
}
