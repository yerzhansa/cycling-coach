import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import {
  DESKTOP_UPDATE_CHECK_CHANNEL,
  DESKTOP_UPDATE_GET_CHANNEL,
  DESKTOP_UPDATE_RESTART_CHANNEL,
  DESKTOP_UPDATE_STATE_CHANNEL,
  DESKTOP_RENDERER_URL,
} from "./constants.js";
import {
  copyDesktopUpdateState,
  type DesktopUpdateController,
  type DesktopUpdateState,
} from "./update-controller.js";

export function installDesktopUpdateIpc(input: {
  readonly ipcMain: Pick<IpcMain, "handle" | "removeHandler">;
  readonly currentWindow: () => BrowserWindow | undefined;
  readonly isTrusted: (event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">) => boolean;
  readonly controller: DesktopUpdateController;
}): () => void {
  let disposed = false;
  const trustedZeroArgument = (
    event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">,
    args: readonly unknown[],
  ): void => {
    if (!input.isTrusted(event)) throw new Error("untrusted desktop update request");
    if (args.length !== 0) throw new TypeError("invalid desktop update request");
  };
  const handlers = [
    [
      DESKTOP_UPDATE_GET_CHANNEL,
      (event: IpcMainInvokeEvent, ...args: unknown[]): DesktopUpdateState => {
        trustedZeroArgument(event, args);
        return copyDesktopUpdateState(input.controller.state());
      },
    ],
    [
      DESKTOP_UPDATE_CHECK_CHANNEL,
      async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<DesktopUpdateState> => {
        trustedZeroArgument(event, args);
        return copyDesktopUpdateState(await input.controller.check());
      },
    ],
    [
      DESKTOP_UPDATE_RESTART_CHANNEL,
      (event: IpcMainInvokeEvent, ...args: unknown[]): DesktopUpdateState => {
        trustedZeroArgument(event, args);
        return copyDesktopUpdateState(input.controller.restart());
      },
    ],
  ] as const;
  for (const [channel, handler] of handlers) input.ipcMain.handle(channel, handler);
  const unsubscribe = input.controller.subscribe((state) => {
    if (disposed) return;
    const window = input.currentWindow();
    if (
      window === undefined ||
      window.isDestroyed() ||
      window.webContents.isDestroyed() ||
      window.webContents.mainFrame.url !== DESKTOP_RENDERER_URL
    ) {
      return;
    }
    window.webContents.send(DESKTOP_UPDATE_STATE_CHANNEL, copyDesktopUpdateState(state));
  });
  return () => {
    if (disposed) return;
    disposed = true;
    unsubscribe();
    for (const [channel] of handlers) input.ipcMain.removeHandler(channel);
  };
}
