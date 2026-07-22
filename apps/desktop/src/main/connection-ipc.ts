import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import { DESKTOP_CONNECTION_CHANNEL } from "./constants.js";
import type { DesktopDaemonLifecycle } from "./daemon-lifecycle.js";
import { isTrustedConnectionRequest } from "./security.js";

export function installDesktopConnectionIpc(input: {
  readonly ipcMain: Pick<IpcMain, "handle" | "removeHandler">;
  readonly currentWindow: () => BrowserWindow | undefined;
  readonly runtime: Pick<DesktopDaemonLifecycle, "connection" | "recover">;
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
      return input.runtime.recover((request as { readonly generation: number }).generation);
    }
    return input.runtime.connection();
  });
  return () => {
    input.ipcMain.removeHandler(DESKTOP_CONNECTION_CHANNEL);
  };
}
