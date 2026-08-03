import { EXIT_SUCCESS, type DaemonOwner, type ExitCode } from "@enduragent/coach-contract";
import { createDaemonHealthState, createHealthzRequestHandler } from "./daemon/healthz-server.js";
import { createCoachRpcServer, ensureDaemonToken } from "./daemon/rpc-server.js";
import { createInvocationCoordinator } from "./daemon/invocation-coordinator.js";
import { createDesktopTelegramController } from "./desktop-telegram-controller.js";
import { createDesktopTelegramRuntimeFactory } from "./desktop-telegram-runtime.js";
import type { LocalCoachLifecycle } from "./local-runner.js";
import { createPackagedSelfTestOperation } from "./packaged-self-test.js";

export interface RunCoachServeInput {
  readonly lifecycle: LocalCoachLifecycle;
  readonly appVersion: string;
  readonly signal: AbortSignal;
  readonly owner?: DaemonOwner;
}

export interface CoachServeDependencies {
  readonly ensureToken: typeof ensureDaemonToken;
  readonly createRpcServer: typeof createCoachRpcServer;
  readonly createHealthzHandler: typeof createHealthzRequestHandler;
  readonly createHealthState: typeof createDaemonHealthState;
  readonly createInvocations: typeof createInvocationCoordinator;
  readonly createTelegramController: typeof createDesktopTelegramController;
  readonly createTelegramRuntimeFactory: typeof createDesktopTelegramRuntimeFactory;
}

const defaultDependencies: CoachServeDependencies = {
  ensureToken: ensureDaemonToken,
  createRpcServer: createCoachRpcServer,
  createHealthzHandler: createHealthzRequestHandler,
  createHealthState: createDaemonHealthState,
  createInvocations: createInvocationCoordinator,
  createTelegramController: createDesktopTelegramController,
  createTelegramRuntimeFactory: createDesktopTelegramRuntimeFactory,
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
    const token = await dependencies.ensureToken(input.lifecycle.home.configDir);
    if (aborted) return EXIT_SUCCESS;
    const spendMeter = input.lifecycle.spendMeter;
    const healthState = dependencies.createHealthState();
    const invocations = dependencies.createInvocations();
    const telegram = dependencies.createTelegramController({
      createRuntime: dependencies.createTelegramRuntimeFactory({
        lifecycle: input.lifecycle,
        invocations,
        appVersion: input.appVersion,
      }),
    });
    const rpc = dependencies.createRpcServer({
      engine: input.lifecycle.engine,
      operations: input.lifecycle.operations,
      spend: {
        getSpendSummary: () => spendMeter.getSpendSummary(),
        setDailySpendCap: ({ dailyCapUsd }) => spendMeter.setDailySpendCap(dailyCapUsd),
      },
      selfTestOperations: { selfTest: createPackagedSelfTestOperation() },
      token: token.value,
      owner: input.owner ?? "unmanaged-foreground",
      athleteHome: input.lifecycle.home.root,
      healthState,
      invocations,
      beforeInvocationDrain: async () => {
        await telegram.stopPolling();
        await telegram.drainPending();
      },
      afterInvocationDrainRefusal: () => telegram.resumePolling(),
    });
    const quiesce = async (): Promise<void> => {
      const fence = invocations.closeAdmission();
      fence.seal();
      healthState.setHealthy(false);
      await telegram.stopPolling();
      await telegram.drainPending();
      await fence.drain();
    };
    if (aborted) {
      await quiesce();
      await rpc.close();
      await telegram.close();
      return EXIT_SUCCESS;
    }
    let binding: Awaited<ReturnType<LocalCoachLifecycle["listener"]["bind"]>>;
    try {
      binding = await input.lifecycle.listener.bind({
        request: dependencies.createHealthzHandler({
          appVersion: input.appVersion,
          state: healthState,
        }),
        upgrade: rpc.handleUpgrade,
      });
    } catch (error) {
      await quiesce().catch(() => {});
      await rpc.close().catch(() => {});
      await telegram.close().catch(() => {});
      throw error;
    }
    if (!aborted) await Promise.race([abortPromise, rpc.shutdownRequested]);
    await quiesce();
    let bindingClose: Promise<void>;
    try {
      bindingClose = binding.close();
    } catch (error) {
      await rpc.close().catch(() => {});
      await telegram.close().catch(() => {});
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
    try {
      await telegram.close();
    } catch (error) {
      cleanupError ??= error;
    }
    if (cleanupError !== undefined) throw cleanupError;
    return EXIT_SUCCESS;
  } finally {
    input.signal.removeEventListener("abort", latchAbort);
  }
}
