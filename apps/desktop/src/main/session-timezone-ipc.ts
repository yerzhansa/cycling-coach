import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import { DESKTOP_SESSION_TIMEZONE_PIN_CHANNEL } from "./constants.js";
import { isTrustedConnectionRequest } from "./security.js";

export function installDesktopSessionTimezoneIpc(input: {
  readonly ipcMain: Pick<IpcMain, "handle" | "removeHandler">;
  readonly currentWindow: () => BrowserWindow | undefined;
  readonly pin: () => Promise<boolean>;
}): () => void {
  const onPin = async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<boolean> => {
    if (!isTrustedConnectionRequest(event, input.currentWindow())) {
      throw new Error("untrusted desktop session timezone request");
    }
    if (args.length !== 0) throw new TypeError("invalid desktop session timezone request");
    return input.pin();
  };

  input.ipcMain.handle(DESKTOP_SESSION_TIMEZONE_PIN_CHANNEL, onPin);
  let installed = true;
  return () => {
    if (!installed) return;
    installed = false;
    input.ipcMain.removeHandler(DESKTOP_SESSION_TIMEZONE_PIN_CHANNEL);
  };
}
