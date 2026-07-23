import type { TrainingSyncCoordinator, TrainingSyncState } from "../training-sync.js";

export const SYNC_QUEUED_COPY = "Sync queued.";
export const SYNC_RUNNING_COPY = "Syncing training data…";
export const SYNC_PUBLISHED_COPY = "Training-data check completed.";
export const SYNC_NO_CHANGE_COPY = "Local training-data processing completed.";
export const SYNC_PARTIAL_COPY =
  "Training-data processing partially completed. Try again to finish.";
export const SYNC_OPERATION_FAILURE_COPY =
  "We couldn’t complete the training-data check. Your existing data is still available.";
export const SYNC_INDETERMINATE_COPY =
  "Connection interrupted. The sync may still be finishing. Enduragent won’t retry it automatically.";
export const SYNC_PROTOCOL_COPY =
  "Enduragent couldn’t verify the sync result. Quit and reopen Enduragent.";

export interface ManualSyncViewState {
  readonly label: "Sync now" | "Sync again" | "Try again" | "Sync unavailable";
  readonly message: string;
  readonly disabled: boolean;
  readonly busy: boolean;
  readonly tone: "idle" | "active" | "success" | "partial" | "failure";
}

export interface ManualSyncView {
  render(state: ManualSyncViewState): void;
  restoreKeyboardFocus(): void;
}

export interface ManualSyncController {
  activate(kind: "keyboard" | "pointer"): Promise<void>;
  dispose(): void;
}

export function toManualSyncViewState(state: TrainingSyncState): ManualSyncViewState {
  switch (state.status) {
    case "idle":
      return { label: "Sync now", message: "", disabled: false, busy: false, tone: "idle" };
    case "queued":
      return {
        label: "Sync now",
        message: SYNC_QUEUED_COPY,
        disabled: true,
        busy: true,
        tone: "active",
      };
    case "running":
      return {
        label: "Sync now",
        message: SYNC_RUNNING_COPY,
        disabled: true,
        busy: true,
        tone: "active",
      };
    case "succeeded":
      return {
        label: "Sync again",
        message: state.kind === "published" ? SYNC_PUBLISHED_COPY : SYNC_NO_CHANGE_COPY,
        disabled: false,
        busy: false,
        tone: "success",
      };
    case "failed":
      if (state.kind === "protocol") {
        return {
          label: "Sync unavailable",
          message: SYNC_PROTOCOL_COPY,
          disabled: true,
          busy: false,
          tone: "failure",
        };
      }
      return {
        label: "Try again",
        message:
          state.kind === "partial"
            ? SYNC_PARTIAL_COPY
            : state.kind === "indeterminate"
              ? SYNC_INDETERMINATE_COPY
              : SYNC_OPERATION_FAILURE_COPY,
        disabled: false,
        busy: false,
        tone: state.kind === "partial" ? "partial" : "failure",
      };
  }
}

export function createManualSyncController(input: {
  readonly coordinator: TrainingSyncCoordinator;
  readonly view: ManualSyncView;
}): ManualSyncController {
  let disposed = false;
  let activation = 0;
  let activationTask: Promise<void> | undefined;
  const unsubscribe = input.coordinator.subscribe((state) => {
    if (!disposed) input.view.render(toManualSyncViewState(state));
  });

  return {
    activate(kind) {
      if (disposed) return Promise.resolve();
      if (activationTask !== undefined) return activationTask;
      const state = input.coordinator.getState();
      if (
        state.status === "queued" ||
        state.status === "running" ||
        (state.status === "failed" && state.kind === "protocol")
      ) {
        return Promise.resolve();
      }
      const selectedActivation = ++activation;
      const task = input.coordinator.request();
      const selectedState = input.coordinator.getState();
      const selectedOperation =
        selectedState.status === "idle" ? undefined : selectedState.operation;
      activationTask = task;
      void task
        .then(() => {
          const currentState = input.coordinator.getState();
          const currentOperation =
            currentState.status === "idle" ? undefined : currentState.operation;
          if (
            !disposed &&
            selectedActivation === activation &&
            selectedOperation === currentOperation &&
            kind === "keyboard"
          ) {
            input.view.restoreKeyboardFocus();
          }
        })
        .finally(() => {
          if (activationTask === task) activationTask = undefined;
        })
        .catch(() => {});
      return task;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      activation += 1;
      activationTask = undefined;
      unsubscribe();
    },
  };
}
