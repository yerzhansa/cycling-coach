import type { StateCreator } from "zustand";
import type { EnduragentState } from "./store.js";

export type ConnectionStatus =
  | "connecting"
  | "ready"
  | "connected"
  | "recovering"
  | "terminal"
  | "failed"
  | "closing";

export interface ConnectionSlice {
  readonly connection: ConnectionStatus;
  setConnection: (status: ConnectionStatus) => void;
}

export const createConnectionSlice: StateCreator<EnduragentState, [], [], ConnectionSlice> = (
  set,
) => ({
  connection: "connecting",
  setConnection(status) {
    if (typeof document !== "undefined") document.documentElement.dataset.rpc = status;
    set({ connection: status });
  },
});

export function observeConnectionLifecycle(
  publish: (status: ConnectionStatus) => void,
): () => void {
  const onLifecycle = (event: WindowEventMap["enduragent-lifecycle"]): void => {
    publish(event.detail.status);
  };
  window.addEventListener("enduragent-lifecycle", onLifecycle);
  return () => {
    window.removeEventListener("enduragent-lifecycle", onLifecycle);
  };
}
