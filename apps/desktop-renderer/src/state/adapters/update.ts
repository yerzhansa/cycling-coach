import type { DesktopUpdateView } from "../../update/controller.js";
import type { UpdateSettingsPort, UpdateSurfaceState } from "../settings-slice.js";

export interface UpdateSettingsAdapter {
  readonly view: DesktopUpdateView;
  readonly port: UpdateSettingsPort;
}

export function createUpdateSettingsAdapter(input: {
  readonly publish: (next: UpdateSurfaceState) => void;
}): UpdateSettingsAdapter {
  let handler: (() => void) | undefined;
  let disposed = false;
  return {
    view: {
      bind(next) {
        handler = next;
      },
      render(state, options) {
        if (disposed) return;
        input.publish({ state, actionDisabled: options?.actionDisabled === true });
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        handler = undefined;
      },
    },
    port: {
      activate: () => handler?.(),
    },
  };
}
