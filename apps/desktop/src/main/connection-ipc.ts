import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import {
  DESKTOP_CONNECTION_CHANNEL,
  DESKTOP_INITIAL_SETUP_STATUS_SETTLED_CHANNEL,
} from "./constants.js";
import type { DesktopDaemonLifecycle } from "./daemon-lifecycle.js";
import { requireDesktopDaemonHome } from "./daemon-home-binding.js";
import { isTrustedConnectionRequest } from "./security.js";

function rendererConnection(
  connection: ReturnType<DesktopDaemonLifecycle["connection"]>,
  expectedAthleteHome: string,
): {
  readonly url: `ws://127.0.0.1:${number}/rpc`;
  readonly rendererCapability: string;
  readonly generation: number;
} {
  requireDesktopDaemonHome(expectedAthleteHome, connection.athleteHome);
  return {
    url: connection.url,
    rendererCapability: connection.rendererCapability,
    generation: connection.generation,
  };
}

export function installDesktopConnectionIpc(input: {
  readonly ipcMain: Pick<IpcMain, "handle" | "removeHandler">;
  readonly currentWindow: () => BrowserWindow | undefined;
  readonly expectedAthleteHome: string;
  readonly runtime: Pick<DesktopDaemonLifecycle, "connection" | "recover">;
  readonly initialSetupStatusSettled: (generation: number) => Promise<void>;
}): () => void {
  const requireTrusted = (event: IpcMainInvokeEvent): void => {
    if (!isTrustedConnectionRequest(event, input.currentWindow())) {
      throw new Error("untrusted desktop connection request");
    }
  };
  input.ipcMain.handle(DESKTOP_CONNECTION_CHANNEL, async (event, request?: unknown) => {
    requireTrusted(event);
    if (request !== undefined) {
      if (
        request === null ||
        typeof request !== "object" ||
        Array.isArray(request) ||
        Object.keys(request).length !== 1 ||
        !Number.isSafeInteger((request as { readonly generation?: unknown }).generation) ||
        ((request as { readonly generation: number }).generation as number) < 1
      ) {
        throw new TypeError("invalid desktop connection request");
      }
      return rendererConnection(
        await input.runtime.recover((request as { readonly generation: number }).generation),
        input.expectedAthleteHome,
      );
    }
    return rendererConnection(input.runtime.connection(), input.expectedAthleteHome);
  });
  input.ipcMain.handle(
    DESKTOP_INITIAL_SETUP_STATUS_SETTLED_CHANNEL,
    async (event, request?: unknown) => {
      requireTrusted(event);
      if (
        request === null ||
        typeof request !== "object" ||
        Array.isArray(request) ||
        Object.keys(request).length !== 1 ||
        !Number.isSafeInteger((request as { readonly generation?: unknown }).generation) ||
        ((request as { readonly generation: number }).generation as number) < 1
      ) {
        throw new TypeError("invalid initial setup status settlement");
      }
      await input.initialSetupStatusSettled(
        (request as { readonly generation: number }).generation,
      );
    },
  );
  return () => {
    input.ipcMain.removeHandler(DESKTOP_CONNECTION_CHANNEL);
    input.ipcMain.removeHandler(DESKTOP_INITIAL_SETUP_STATUS_SETTLED_CHANNEL);
  };
}
