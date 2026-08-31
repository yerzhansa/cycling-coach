import type { StateCreator } from "zustand";
import {
  IDLE_TRAINING_EXPORT,
  type TrainingExportController,
  type TrainingExportState,
} from "../training-export/controller";
import type { EnduragentState } from "./store";

export interface TrainingExportSlice {
  readonly trainingExport: TrainingExportState;
  readonly trainingExportActions: TrainingExportController | null;
  setTrainingExport: (next: TrainingExportState) => void;
  bindTrainingExportActions: (actions: TrainingExportController | null) => void;
}

export const createTrainingExportSlice: StateCreator<
  EnduragentState,
  [],
  [],
  TrainingExportSlice
> = (set) => ({
  trainingExport: IDLE_TRAINING_EXPORT,
  trainingExportActions: null,
  setTrainingExport(next) {
    set({ trainingExport: next });
  },
  bindTrainingExportActions(actions) {
    set({ trainingExportActions: actions });
  },
});
