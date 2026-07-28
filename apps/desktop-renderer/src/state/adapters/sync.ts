import type { ManualSyncView, ManualSyncViewState } from "../../training-context/manual-sync.js";

export interface ManualSyncViewAdapter {
  readonly view: ManualSyncView;
}

export function createManualSyncViewAdapter(input: {
  readonly publish: (next: ManualSyncViewState) => void;
  readonly restoreFocus: () => void;
}): ManualSyncViewAdapter {
  return {
    view: {
      render(state) {
        input.publish(state);
      },
      restoreKeyboardFocus() {
        input.restoreFocus();
      },
    },
  };
}
