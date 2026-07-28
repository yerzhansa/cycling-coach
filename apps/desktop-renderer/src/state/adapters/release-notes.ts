import type { ReleaseNotesView } from "../../release-notes/controller.js";
import type { ReleaseNotesSettingsPort, ReleaseNotesSurfaceState } from "../settings-slice.js";

export interface ReleaseNotesSettingsAdapter {
  readonly view: ReleaseNotesView;
  readonly port: ReleaseNotesSettingsPort;
}

export function createReleaseNotesSettingsAdapter(input: {
  readonly publish: (patch: {
    readonly releaseNotes?: ReleaseNotesSurfaceState;
    readonly releaseNotesOpen?: boolean;
  }) => void;
}): ReleaseNotesSettingsAdapter {
  let handlers: Parameters<ReleaseNotesView["bind"]>[0] | undefined;
  let disposed = false;
  return {
    view: {
      bind(next) {
        handlers = next;
      },
      open() {
        if (!disposed) input.publish({ releaseNotesOpen: true });
      },
      close() {
        if (!disposed) input.publish({ releaseNotesOpen: false });
      },
      renderLoading() {
        if (!disposed) input.publish({ releaseNotes: { status: "loading" } });
      },
      renderAvailable(result) {
        if (disposed) return;
        input.publish({
          releaseNotes: {
            status: "available",
            version: result.version,
            notes: result.notes,
            releaseUrl: result.releaseUrl,
          },
        });
      },
      renderUnavailable({ version, releaseUrl }) {
        if (disposed) return;
        input.publish({ releaseNotes: { status: "unavailable", version, releaseUrl } });
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        handlers = undefined;
        input.publish({ releaseNotes: { status: "idle" }, releaseNotesOpen: false });
      },
    },
    port: {
      open: () => handlers?.onOpen(),
      retry: () => handlers?.onRetry(),
      close: () => handlers?.onClose(),
    },
  };
}
