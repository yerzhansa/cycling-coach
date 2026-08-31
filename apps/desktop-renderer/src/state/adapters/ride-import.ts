import type { RideImportController, RideImportState } from "../../ride-import";
import type { RideImportActions } from "../ride-import-slice";

export interface RideImportAdapter {
  readonly port: RideImportActions;
  dispose(): void;
}

export function createRideImportAdapter(input: {
  readonly imports: RideImportController;
  readonly publish: (next: RideImportState) => void;
  readonly onSucceeded?: () => void;
}): RideImportAdapter {
  let disposed = false;
  const unsubscribe = input.imports.subscribe((state) => {
    if (disposed) return;
    input.publish(state);
    if (state.status === "succeeded") input.onSucceeded?.();
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
