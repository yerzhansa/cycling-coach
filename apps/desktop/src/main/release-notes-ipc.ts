import { fetchLatestReleaseNotes, type ReleaseNotesResult } from "@enduragent/core";
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import { DESKTOP_RELEASE_NOTES_CHANNEL } from "./constants.js";
import { isTrustedConnectionRequest } from "./security.js";

const RELEASE_NOTES_REPO = Object.freeze({
  owner: "yerzhansa",
  name: "enduragent",
});
const RELEASES_URL = "https://github.com/yerzhansa/enduragent/releases";

function unavailableReleaseNotes(): ReleaseNotesResult {
  return {
    status: "unavailable",
    version: null,
    releaseUrl: RELEASES_URL,
  };
}

export function installDesktopReleaseNotesIpc(input: {
  readonly ipcMain: Pick<IpcMain, "handle" | "removeHandler">;
  readonly currentWindow: () => BrowserWindow | undefined;
  readonly loadReleaseNotes?: typeof fetchLatestReleaseNotes;
}): () => void {
  const loadReleaseNotes = input.loadReleaseNotes ?? fetchLatestReleaseNotes;
  let inFlight: Promise<ReleaseNotesResult> | undefined;

  const performLoad = async (): Promise<ReleaseNotesResult> => {
    try {
      const result = await loadReleaseNotes("cycling-coach", RELEASE_NOTES_REPO);
      if (result.status === "available") {
        return {
          status: "available",
          version: result.version,
          notes: [...result.notes],
          releaseUrl: result.releaseUrl,
        };
      }
      if (result.status === "unavailable") {
        return {
          status: "unavailable",
          version: result.version,
          releaseUrl: result.releaseUrl,
        };
      }
      return unavailableReleaseNotes();
    } catch {
      return unavailableReleaseNotes();
    }
  };

  const onReleaseNotes = (
    event: IpcMainInvokeEvent,
    ...args: unknown[]
  ): Promise<ReleaseNotesResult> => {
    if (!isTrustedConnectionRequest(event, input.currentWindow())) {
      throw new Error("untrusted desktop release notes request");
    }
    if (args.length !== 0) {
      throw new TypeError("invalid desktop release notes request");
    }
    if (inFlight !== undefined) return inFlight;

    const pending = performLoad();
    inFlight = pending;
    const clear = (): void => {
      if (inFlight === pending) inFlight = undefined;
    };
    void pending.then(clear, clear);
    return pending;
  };

  input.ipcMain.handle(DESKTOP_RELEASE_NOTES_CHANNEL, onReleaseNotes);
  let installed = true;
  return () => {
    if (!installed) return;
    installed = false;
    input.ipcMain.removeHandler(DESKTOP_RELEASE_NOTES_CHANNEL);
  };
}
