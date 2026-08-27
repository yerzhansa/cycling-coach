import type { PlanNavigationTarget, PlanningReadModel } from "@enduragent/coach-contract";
import type { PlanReadSurfaceState } from "../state/plan-slice.js";

export interface PlanController {
  start(): Promise<void>;
  refresh(): Promise<void>;
  openFromChat(target: PlanNavigationTarget): void;
  backToChat(): void;
  dispose(): void;
}

export function createPlanController(input: {
  readonly read: () => Promise<PlanningReadModel>;
  readonly render: (state: PlanReadSurfaceState) => void;
  readonly navigate: (view: "chat" | "plan") => void;
  readonly focus: (target: PlanNavigationTarget | null, returnToChat: boolean) => void;
}): PlanController {
  let disposed = false;
  let value: PlanningReadModel | null = null;
  let pending: Promise<void> | undefined;

  const refresh = (): Promise<void> => {
    if (pending !== undefined) return pending;
    input.render(value === null ? { status: "loading", value: null } : { status: "ready", value });
    const task = input
      .read()
      .then((next) => {
        if (disposed) return;
        value = next;
        input.render({ status: "ready", value: next });
      })
      .catch(() => {
        if (!disposed) input.render({ status: "unavailable", value });
      })
      .finally(() => {
        if (pending === task) pending = undefined;
      });
    pending = task;
    return task;
  };

  return {
    start: refresh,
    refresh,
    openFromChat(target) {
      input.focus(target, true);
      input.navigate("plan");
      void refresh();
    },
    backToChat() {
      input.focus(null, false);
      input.navigate("chat");
    },
    dispose() {
      disposed = true;
    },
  };
}
