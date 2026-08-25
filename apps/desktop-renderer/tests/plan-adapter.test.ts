import type {
  ExecutePlanTransitionRpcResult,
  GetPlanStateRpcResult,
  PlanHydrationState,
  PlanProgressEvent,
} from "@enduragent/coach-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPlanViewAdapter,
  type PlanBridge,
} from "../src/state/adapters/plan.js";
import {
  EMPTY_PLAN_SURFACE,
  type PlanSurfaceState,
  type PlanTransitionState,
} from "../src/state/plan-slice.js";
import { PLAN_ERROR, planReadModel } from "./plan-fixtures.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function harness(input: {
  readonly getPlanState?: () => Promise<GetPlanStateRpcResult>;
  readonly executePlanTransition?: PlanBridge["executePlanTransition"];
  readonly ids?: readonly string[];
} = {}) {
  let surface: PlanSurfaceState = EMPTY_PLAN_SURFACE;
  let progressListener: ((progress: PlanProgressEvent) => void) | null = null;
  const disposeProgress = vi.fn();
  const defaultGetPlanState: PlanBridge["getPlanState"] = async () => ({
    status: "ready",
    state: planReadModel(),
  });
  const defaultExecute: PlanBridge["executePlanTransition"] = async () => ({
    status: "completed",
    state: planReadModel(),
  });
  const getPlanState = vi.fn<PlanBridge["getPlanState"]>(
    input.getPlanState ?? defaultGetPlanState,
  );
  const executePlanTransition = vi.fn<PlanBridge["executePlanTransition"]>(
    input.executePlanTransition ?? defaultExecute,
  );
  const ids = [...(input.ids ?? ["command-1", "command-2", "command-3"])];
  const adapter = createPlanViewAdapter({
    bridge: {
      getPlanState,
      executePlanTransition,
      onPlanProgress(listener) {
        progressListener = listener;
        return disposeProgress;
      },
    },
    read: () => surface,
    publishHydration(next: PlanHydrationState) {
      const lastReady =
        next.status === "ready" || next.status === "stale" ? next.state : surface.lastReady;
      surface = { ...surface, hydration: next, lastReady };
    },
    publishTransition(next: PlanTransitionState) {
      surface = { ...surface, transition: next };
    },
    createCommandId: () => ids.shift() ?? "unexpected-command",
  });
  return {
    adapter,
    get surface() {
      return surface;
    },
    getPlanState,
    executePlanTransition,
    disposeProgress,
    progress(value: PlanProgressEvent) {
      progressListener?.(value);
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Plan view adapter", () => {
  it("subscribes and hydrates once", async () => {
    const subject = harness();

    subject.adapter.start();
    subject.adapter.start();
    await settle();

    expect(subject.getPlanState).toHaveBeenCalledOnce();
    expect(subject.surface.hydration).toEqual({ status: "ready", state: planReadModel() });
  });

  it("keeps hydration failure retryable", async () => {
    const first = deferred<GetPlanStateRpcResult>();
    const getPlanState = vi
      .fn<() => Promise<GetPlanStateRpcResult>>()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce({ status: "ready", state: planReadModel() });
    const subject = harness({ getPlanState });

    subject.adapter.start();
    first.reject(new TypeError());
    await settle();
    expect(subject.surface.hydration).toEqual({ status: "failed", error: expect.any(Object) });

    subject.adapter.retry();
    await settle();
    expect(subject.surface.hydration.status).toBe("ready");
    expect(getPlanState).toHaveBeenCalledTimes(2);
  });

  it("dispatches PL-T01 with one stable command identifier", async () => {
    const execute = deferred<ExecutePlanTransitionRpcResult>();
    const subject = harness({
      ids: ["create-draft-command"],
      executePlanTransition: () => execute.promise,
    });

    subject.adapter.startPlan();
    expect(subject.executePlanTransition).toHaveBeenCalledWith({
      transitionId: "PL-T01",
      commandId: "create-draft-command",
      sourceConversationId: null,
    });
    expect(subject.surface.transition).toEqual({
      status: "submitting",
      transitionId: "PL-T01",
      commandId: "create-draft-command",
    });

    execute.resolve({ status: "completed", state: planReadModel({ lifecycle: "intake", projection: "coach" }) });
    await settle();
    expect(subject.surface.transition).toEqual({ status: "idle" });
    expect(subject.surface.hydration.status).toBe("ready");
  });

  it("keeps a rejected transition inside Plan and retries it with a new command", async () => {
    const subject = harness({
      ids: ["rejected-command", "retry-command"],
      executePlanTransition: async () => ({
        status: "rejected",
        error: PLAN_ERROR,
        state: planReadModel(),
      }),
    });

    subject.adapter.startPlan();
    await settle();
    expect(subject.surface.transition).toEqual({
      status: "failed",
      commandId: "rejected-command",
      transitionId: "PL-T01",
      error: PLAN_ERROR,
    });

    subject.adapter.retry();
    await settle();
    expect(subject.executePlanTransition).toHaveBeenLastCalledWith({
      transitionId: "PL-T01",
      commandId: "retry-command",
      sourceConversationId: null,
    });
  });

  it.each([
    { count: 1, projection: "workout" as const },
    { count: 2, projection: "attention" as const },
  ])("routes $count unresolved item(s) through PL-T33", async ({ count, projection }) => {
    const model = planReadModel({ attentionCount: count, planId: "plan-1" });
    const subject = harness({
      ids: ["attention-command"],
      getPlanState: async () => ({ status: "ready", state: model }),
      executePlanTransition: async () => ({
        status: "completed",
        state: planReadModel({
          attentionCount: count,
          lifecycle: "active",
          planId: "plan-1",
          projection,
        }),
      }),
    });
    subject.adapter.start();
    await settle();

    subject.adapter.open();
    await settle();

    expect(subject.executePlanTransition).toHaveBeenCalledWith({
      transitionId: "PL-T33",
      commandId: "attention-command",
      planId: "plan-1",
    });
    expect(subject.surface.hydration.status).toBe("ready");
    if (subject.surface.hydration.status === "ready") {
      expect(subject.surface.hydration.state.projection).toBe(projection);
    }
  });

  it("opens ordinary Plan without dispatching when attention is empty", async () => {
    const subject = harness();
    subject.adapter.start();
    await settle();

    subject.adapter.open();
    await settle();

    expect(subject.executePlanTransition).not.toHaveBeenCalled();
    expect(subject.getPlanState).toHaveBeenCalledTimes(2);
  });

  it("accepts progress only for the current command, transition, and operation", async () => {
    const state = planReadModel({ lifecycle: "intake", projection: "coach" });
    const subject = harness({
      ids: ["command-1"],
      executePlanTransition: async () => ({ status: "accepted", operationId: "operation-1", state }),
    });
    subject.adapter.start();
    await settle();
    subject.adapter.startPlan();
    await settle();

    const matching: PlanProgressEvent = {
      commandId: "command-1",
      transitionId: "PL-T01",
      operationId: "operation-1",
      phase: "running",
      completed: 1,
      total: 2,
    };
    subject.progress({ ...matching, operationId: "other-operation" });
    expect(subject.surface.transition).toMatchObject({ progress: null });

    subject.progress(matching);
    expect(subject.surface.transition).toMatchObject({ progress: matching });

    subject.progress({ ...matching, phase: "completed", completed: 2 });
    await settle();
    expect(subject.getPlanState).toHaveBeenCalledTimes(2);
  });

  it("disposes the progress subscription and ignores pending hydration", async () => {
    const load = deferred<GetPlanStateRpcResult>();
    const subject = harness({ getPlanState: () => load.promise });
    subject.adapter.start();

    subject.adapter.dispose();
    load.resolve({ status: "ready", state: planReadModel() });
    await settle();

    expect(subject.disposeProgress).toHaveBeenCalledOnce();
    expect(subject.surface.hydration).toEqual({ status: "loading" });
  });
});
