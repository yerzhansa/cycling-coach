import type { RideImportController, RideImportState } from "../../ride-import.js";
import type { RideImportActions } from "../ride-import-slice.js";

export interface RideImportAdapter {
  readonly port: RideImportActions;
  dispose(): void;
}

export function createRideImportAdapter(input: {
  readonly imports: RideImportController;
  readonly publish: (next: RideImportState) => void;
}): RideImportAdapter {
  let disposed = false;
  const unsubscribe = input.imports.subscribe((state) => {
    if (!disposed) input.publish(state);
  });

  return {
    port: {
      choose() {
        if (disposed) return;
        void input.imports.chooseAndImport("resident");
      },
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
    },
  };
}
