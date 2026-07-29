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

type ConnectionTone = "pending" | "connected" | "recovering" | "unavailable";

const TONES: Readonly<Record<ConnectionStatus, ConnectionTone>> = {
  connecting: "pending",
  ready: "connected",
  connected: "connected",
  recovering: "recovering",
  terminal: "unavailable",
  failed: "unavailable",
  closing: "pending",
};

const COPY: Readonly<Record<ConnectionStatus, string>> = {
  connecting: "Connecting…",
  ready: "Connected",
  connected: "Connected",
  recovering: "Reconnecting…",
  terminal: "Connection unavailable",
  failed: "Connection unavailable",
  closing: "Closing…",
};

export function connectionTone(status: ConnectionStatus): ConnectionTone {
  return TONES[status];
}

export function connectionCopy(status: ConnectionStatus): string {
  return COPY[status];
}

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
