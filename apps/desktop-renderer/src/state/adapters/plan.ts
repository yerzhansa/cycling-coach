import type {
  ExecutePlanTransitionRpcParams,
  ExecutePlanTransitionRpcResult,
  GetPlanStateRpcResult,
  PlanError,
  PlanHydrationState,
  PlanProgressEvent,
  PlanReadModel,
  PlanTransitionId,
} from "@enduragent/coach-contract";
import type { PlanSurfaceState, PlanTransitionState } from "../plan-slice.js";
import { planReadModel } from "../plan-slice.js";

export interface PlanBridge {
  getPlanState(): Promise<GetPlanStateRpcResult>;
  executePlanTransition(
    input: ExecutePlanTransitionRpcParams,
  ): Promise<ExecutePlanTransitionRpcResult>;
  onPlanProgress(listener: (progress: PlanProgressEvent) => void): () => void;
}

export interface PlanViewAdapter {
  start(): void;
  open(): void;
  startPlan(): void;
  retry(): void;
  dispose(): void;
}

const UNAVAILABLE_ERROR: PlanError = Object.freeze({
  code: "unavailable",
  message: "Plan could not connect. Try again.",
  retryable: true,
});

function hydrationFromResult(result: GetPlanStateRpcResult): PlanHydrationState {
  return result;
}

function hydrationFromTransition(result: ExecutePlanTransitionRpcResult): PlanHydrationState {
  if (result.status === "unsupported-capability") return result;
  return { status: "ready", state: result.state };
}

export function createPlanViewAdapter(input: {
  readonly bridge: PlanBridge;
  readonly read: () => PlanSurfaceState;
  readonly publishHydration: (next: PlanHydrationState) => void;
  readonly publishTransition: (next: PlanTransitionState) => void;
  readonly createCommandId?: () => string;
}): PlanViewAdapter {
  const createCommandId = input.createCommandId ?? (() => globalThis.crypto.randomUUID());
  let disposed = false;
  let started = false;
  let disposeProgress: (() => void) | null = null;
  let hydrationGeneration = 0;
  let lastRetry: "hydrate" | "start" | "attention" = "hydrate";
  let active:
    | {
        readonly commandId: string;
        readonly transitionId: PlanTransitionId;
        operationId: string | null;
      }
    | null = null;

  const refresh = async (showLoading: boolean): Promise<void> => {
    const generation = ++hydrationGeneration;
    if (showLoading && input.read().lastReady === null) {
      input.publishHydration({ status: "loading" });
    }
    try {
      const result = await input.bridge.getPlanState();
      if (disposed || generation !== hydrationGeneration) return;
      input.publishHydration(hydrationFromResult(result));
    } catch {
      if (disposed || generation !== hydrationGeneration) return;
      input.publishHydration({ status: "failed", error: UNAVAILABLE_ERROR });
    }
  };

  const execute = async (
    command: ExecutePlanTransitionRpcParams,
    retry: "start" | "attention",
  ): Promise<void> => {
    active = {
      commandId: command.commandId,
      transitionId: command.transitionId,
      operationId: null,
    };
    lastRetry = retry;
    input.publishTransition({
      status: "submitting",
      commandId: command.commandId,
      transitionId: command.transitionId,
    });
    try {
      const result = await input.bridge.executePlanTransition(command);
      if (
        disposed ||
        active?.commandId !== command.commandId ||
        active.transitionId !== command.transitionId
      ) {
        return;
      }
      input.publishHydration(hydrationFromTransition(result));
      if (result.status === "unsupported-capability") {
        active = null;
        input.publishTransition({ status: "idle" });
        return;
      }
      if (result.status === "rejected") {
        active = null;
        input.publishTransition({
          status: "failed",
          commandId: command.commandId,
          transitionId: command.transitionId,
          error: result.error,
        });
        return;
      }
      if (result.status === "accepted") {
        active.operationId = result.operationId;
        input.publishTransition({
          status: "running",
          commandId: command.commandId,
          transitionId: command.transitionId,
          operationId: result.operationId,
          progress: result.state.activeOperation,
        });
        return;
      }
      active = null;
      input.publishTransition({ status: "idle" });
    } catch {
      if (
        disposed ||
        active?.commandId !== command.commandId ||
        active.transitionId !== command.transitionId
      ) {
        return;
      }
      active = null;
      input.publishTransition({
        status: "failed",
        commandId: command.commandId,
        transitionId: command.transitionId,
        error: UNAVAILABLE_ERROR,
      });
    }
  };

  const startPlan = (): void => {
    if (active !== null) return;
    const commandId = createCommandId();
    void execute(
      { transitionId: "PL-T01", commandId, sourceConversationId: null },
      "start",
    );
  };

  const open = (): void => {
    if (active !== null) return;
    const model: PlanReadModel | null = planReadModel(input.read());
    if (model === null) return;
    if (model.attention.destination === "none") {
      lastRetry = "hydrate";
      void refresh(false);
      return;
    }
    if (model.planId === null) {
      lastRetry = "hydrate";
      void refresh(false);
      return;
    }
    const commandId = createCommandId();
    void execute(
      { transitionId: "PL-T33", commandId, planId: model.planId },
      "attention",
    );
  };

  const onProgress = (progress: PlanProgressEvent): void => {
    if (
      disposed ||
      active === null ||
      active.operationId === null ||
      progress.commandId !== active.commandId ||
      progress.transitionId !== active.transitionId ||
      progress.operationId !== active.operationId
    ) {
      return;
    }
    input.publishTransition({
      status: "running",
      commandId: active.commandId,
      transitionId: active.transitionId,
      operationId: active.operationId,
      progress,
    });
    if (progress.phase === "completed" || progress.phase === "failed") {
      active = null;
      input.publishTransition({ status: "idle" });
      void refresh(false);
    }
  };

  return {
    start() {
      if (started || disposed) return;
      started = true;
      disposeProgress = input.bridge.onPlanProgress(onProgress);
      void refresh(true);
    },
    open,
    startPlan,
    retry() {
      if (lastRetry === "start") startPlan();
      else if (lastRetry === "attention") open();
      else void refresh(input.read().lastReady === null);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      hydrationGeneration += 1;
      active = null;
      disposeProgress?.();
      disposeProgress = null;
    },
  };
}
