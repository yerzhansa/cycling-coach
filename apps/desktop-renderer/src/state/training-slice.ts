import { UNKNOWN_CYCLING_TRAINING_CONTEXT } from "@enduragent/coach-contract";
import type { StateCreator } from "zustand";
import type { TrainingContextViewState } from "../training-context/controller.js";
import type { EnduragentState } from "./store.js";

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
  setTraining: (next: TrainingContextViewState) => void;
}

export const createTrainingSlice: StateCreator<EnduragentState, [], [], TrainingSlice> = (set) => ({
  training: EMPTY_TRAINING_SURFACE,
  setTraining(next) {
    set({ training: next });
  },
});
