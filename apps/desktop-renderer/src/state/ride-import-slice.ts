import type { StateCreator } from "zustand";
import type { RideImportState } from "../ride-import.js";
import type { EnduragentState } from "./store.js";

export interface RideImportActions {
  choose(): void;
}

export const IDLE_RIDE_IMPORT: RideImportState = Object.freeze({
  status: "idle" as const,
  owner: null,
  progress: null,
  result: null,
});

export interface RideImportSlice {
  readonly rideImport: RideImportState;
  readonly rideImportSuppressed: boolean;
  readonly rideImportActions: RideImportActions | null;
  setRideImport: (next: RideImportState) => void;
  setRideImportSuppressed: (suppressed: boolean) => void;
  bindRideImportActions: (actions: RideImportActions | null) => void;
}

export const createRideImportSlice: StateCreator<EnduragentState, [], [], RideImportSlice> = (
  set,
) => ({
  rideImport: IDLE_RIDE_IMPORT,
  rideImportSuppressed: false,
  rideImportActions: null,
  setRideImport(next) {
    set({ rideImport: next });
  },
  setRideImportSuppressed(suppressed) {
    set({ rideImportSuppressed: suppressed });
  },
  bindRideImportActions(actions) {
    set({ rideImportActions: actions });
  },
});
