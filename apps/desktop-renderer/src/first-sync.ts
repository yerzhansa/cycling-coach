import { CoachClientDisconnectedError, CoachClientProtocolError } from "@enduragent/coach-client";
import type {
  CoachOperationProgressNotificationEnvelope,
  SyncRpcResult,
} from "@enduragent/coach-contract";
import type { OnboardingCompletion } from "./onboarding/machine.js";

export type FirstSyncState =
  | { readonly status: "idle" }
  | { readonly status: "syncing" }
  | { readonly status: "ready" }
  | {
      readonly status: "failed";
      readonly kind: "operation" | "disconnected" | "protocol";
      readonly retryable: boolean;
    };

export interface FirstSyncCallOptions {
  readonly onNotificationEnvelope: (envelope: CoachOperationProgressNotificationEnvelope) => void;
}

export interface FirstSyncPorts {
  callSync(options: FirstSyncCallOptions): Promise<SyncRpcResult>;
  focusComposer(): void;
  render(state: FirstSyncState): void;
}

export interface FirstSyncController {
  start(completion: OnboardingCompletion): Promise<void>;
  retry(): Promise<void>;
  dispose(): void;
}

function validCompletion(value: unknown): value is OnboardingCompletion {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate).sort();
  return (
    keys.join(",") === "intakeSaved,providerConfigured,trainingDataConfigured" &&
    candidate.providerConfigured === true &&
    candidate.trainingDataConfigured === true &&
    candidate.intakeSaved === true
  );
}

export function createFirstSyncController(ports: FirstSyncPorts): FirstSyncController {
  let state: FirstSyncState = { status: "idle" };
  let epoch = 0;
  let inFlight: Promise<void> | undefined;
  let disposed = false;
  let composerFocused = false;

  const render = (next: FirstSyncState): void => {
    state = next;
    ports.render(state);
  };

  const begin = (): Promise<void> => {
    const selectedEpoch = ++epoch;
    render({ status: "syncing" });
    let progress = 0;
    let requestId: string | number | undefined;
    let protocolFault = false;
    let settled = false;

    const failProtocol = (): void => {
      if (disposed || selectedEpoch !== epoch) return;
      protocolFault = true;
      if (settled) render({ status: "failed", kind: "protocol", retryable: false });
    };

    const task = (async () => {
      let result: SyncRpcResult | undefined;
      let failure: unknown;
      try {
        result = await ports.callSync({
          onNotificationEnvelope(envelope) {
            if (disposed || selectedEpoch !== epoch) return;
            if (settled) {
              failProtocol();
              return;
            }
            if (
              envelope.jsonrpc !== "2.0" ||
              envelope.method !== "coach.operationProgress" ||
              envelope.params.requestMethod !== "sync"
            ) {
              failProtocol();
              return;
            }
            const event = envelope.params.event;
            if (progress === 0) {
              if (event.phase !== "started" || event.completed !== 0 || event.total !== 1) {
                failProtocol();
                return;
              }
              requestId = envelope.params.requestId;
              progress = 1;
              return;
            }
            if (
              progress !== 1 ||
              envelope.params.requestId !== requestId ||
              event.phase !== "completed" ||
              event.completed !== 1 ||
              event.total !== 1
            ) {
              failProtocol();
              return;
            }
            progress = 2;
          },
        });
      } catch (error) {
        failure = error;
      }
      if (disposed || selectedEpoch !== epoch) return;
      settled = true;
      if (protocolFault || failure instanceof CoachClientProtocolError) {
        render({ status: "failed", kind: "protocol", retryable: false });
        return;
      }
      if (failure !== undefined) {
        render({
          status: "failed",
          kind: failure instanceof CoachClientDisconnectedError ? "disconnected" : "operation",
          retryable: true,
        });
        return;
      }
      if (progress !== 2) {
        render({ status: "failed", kind: "protocol", retryable: false });
        return;
      }
      if (result?.published !== true || result.referenceSucceeded !== true) {
        render({ status: "failed", kind: "operation", retryable: true });
        return;
      }
      render({ status: "ready" });
      if (!composerFocused) {
        composerFocused = true;
        ports.focusComposer();
      }
    })();
    inFlight = task;
    void task
      .finally(() => {
        if (inFlight === task) inFlight = undefined;
      })
      .catch(() => {});
    return task;
  };

  return {
    start(completion) {
      if (!validCompletion(completion)) return Promise.reject(new TypeError("Invalid completion."));
      if (disposed) return Promise.resolve();
      if (inFlight !== undefined) return inFlight;
      if (state.status === "idle" || state.status === "ready") return begin();
      return Promise.resolve();
    },
    retry() {
      if (disposed || inFlight !== undefined || state.status !== "failed" || !state.retryable) {
        return inFlight ?? Promise.resolve();
      }
      return begin();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      epoch += 1;
    },
  };
}
