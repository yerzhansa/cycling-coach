import type {
  TrainingContextView,
  TrainingContextViewState,
  UnitsPreferenceViewState,
} from "../../training-context/controller.js";

export interface TrainingViewAdapter {
  readonly view: TrainingContextView;
}

export function createTrainingViewAdapter(input: {
  readonly readUnits: () => UnitsPreferenceViewState;
  readonly publish: (next: TrainingContextViewState) => void;
  readonly publishUnits: (next: UnitsPreferenceViewState) => void;
}): TrainingViewAdapter {
  return {
    view: {
      render(state) {
        input.publish(state);
        const current = input.readUnits();
        const next = state.unitsPreference;
        if (
          current.status !== next.status ||
          current.value !== next.value ||
          current.source !== next.source
        ) {
          input.publishUnits(next);
        }
      },
    },
  };
}
