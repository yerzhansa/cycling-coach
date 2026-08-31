import type { StateCreator } from "zustand";
import type { ManualSyncViewState } from "../training-context/manual-sync";
import type { EnduragentState } from "./store";

export interface SyncActions {
  request(kind: "keyboard" | "pointer"): void;
}

export const IDLE_MANUAL_SYNC: ManualSyncViewState = Object.freeze({
  label: "Sync now" as const,
  message: "",
  disabled: false,
  busy: false,
  tone: "idle" as const,
});

export interface SyncSlice {
  readonly sync: ManualSyncViewState;
  readonly syncActions: SyncActions | null;
  setSync: (next: ManualSyncViewState) => void;
  bindSyncActions: (actions: SyncActions | null) => void;
}

export const createSyncSlice: StateCreator<EnduragentState, [], [], SyncSlice> = (set) => ({
  sync: IDLE_MANUAL_SYNC,
  syncActions: null,
  setSync(next) {
    set({ sync: next });
  },
  bindSyncActions(actions) {
    set({ syncActions: actions });
  },
});
