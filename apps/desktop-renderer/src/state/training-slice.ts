import { UNKNOWN_CYCLING_TRAINING_CONTEXT, type RecentRide } from "@enduragent/coach-contract";
import type { StateCreator } from "zustand";
import type { TrainingContextViewState } from "../training-context/controller";
import type { EnduragentState } from "./store";

export const EMPTY_TRAINING_SURFACE: TrainingContextViewState = Object.freeze({
  status: "loading" as const,
  metadata: null,
  trainingContext: UNKNOWN_CYCLING_TRAINING_CONTEXT,
  unitsPreference: Object.freeze({
    status: "loading" as const,
    value: "metric" as const,
    source: "default" as const,
  }),
});

export interface TrainingSlice {
  readonly training: TrainingContextViewState;
  readonly selectedRide: RecentRide | null;
  setTraining: (next: TrainingContextViewState) => void;
  openRide: (ride: RecentRide) => void;
  closeRide: () => void;
}

function reconciledRide(
  current: RecentRide | null,
  next: TrainingContextViewState,
): RecentRide | null {
  const recent = next.trainingContext.recentRides;
  if (current === null) return null;
  if (recent.kind === "computed") {
    return recent.items.find((ride) => ride.id === current.id) ?? null;
  }
  return recent.reason === "temporary-failure" ? current : null;
}

export const createTrainingSlice: StateCreator<EnduragentState, [], [], TrainingSlice> = (
  set,
  get,
) => ({
  training: EMPTY_TRAINING_SURFACE,
  selectedRide: null,
  setTraining(next) {
    set({ training: next, selectedRide: reconciledRide(get().selectedRide, next) });
  },
  openRide(ride) {
    set({ selectedRide: ride });
  },
  closeRide() {
    set({ selectedRide: null });
  },
});
