import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import {
  DESKTOP_SESSION_TIMEZONE_MODE_CHANNEL,
  DESKTOP_SESSION_TIMEZONE_NOTICE_CHANNEL,
  DESKTOP_SESSION_TIMEZONE_SETTING_CHANNEL,
} from "./constants.js";
import { isTrustedConnectionRequest } from "./security.js";
import {
  NO_SESSION_TIMEZONE_NOTICE,
  parseSessionTimezoneMode,
  type DesktopSessionTimezoneNotice,
  type DesktopSessionTimezoneSetting,
  type SessionTimezoneMode,
} from "./session-timezone-contract.js";

export interface DesktopSessionTimezoneNoticeStore {
  read(): DesktopSessionTimezoneNotice;
  set(notice: DesktopSessionTimezoneNotice): void;
  clear(): void;
}

export function createSessionTimezoneNoticeStore(): DesktopSessionTimezoneNoticeStore {
  let current: DesktopSessionTimezoneNotice = NO_SESSION_TIMEZONE_NOTICE;
  return {
    read: () => current,
    set(notice) {
      current = notice;
    },
    clear() {
      current = NO_SESSION_TIMEZONE_NOTICE;
    },
  };
}

export function installDesktopSessionTimezoneIpc(input: {
  readonly ipcMain: Pick<IpcMain, "handle" | "removeHandler">;
  readonly currentWindow: () => BrowserWindow | undefined;
  readonly notices: DesktopSessionTimezoneNoticeStore;
  readonly readSetting: () => Promise<DesktopSessionTimezoneSetting>;
  readonly chooseMode: (mode: SessionTimezoneMode) => Promise<boolean>;
}): () => void {
  const assertTrusted = (event: IpcMainInvokeEvent, args: readonly unknown[], arity: number) => {
    if (!isTrustedConnectionRequest(event, input.currentWindow())) {
      throw new Error("untrusted desktop session timezone request");
    }
    if (args.length !== arity) throw new TypeError("invalid desktop session timezone request");
  };

  const onNotice = (event: IpcMainInvokeEvent, ...args: unknown[]): DesktopSessionTimezoneNotice => {
    assertTrusted(event, args, 0);
    return input.notices.read();
  };

  const onSetting = async (
    event: IpcMainInvokeEvent,
    ...args: unknown[]
  ): Promise<DesktopSessionTimezoneSetting> => {
    assertTrusted(event, args, 0);
    return input.readSetting();
  };

  const onChooseMode = async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<boolean> => {
    assertTrusted(event, args, 1);
    const mode = parseSessionTimezoneMode(args[0]);
    if (mode === undefined) throw new TypeError("invalid desktop session timezone mode");
    const chosen = await input.chooseMode(mode);
    if (chosen) input.notices.clear();
    return chosen;
  };

  input.ipcMain.handle(DESKTOP_SESSION_TIMEZONE_NOTICE_CHANNEL, onNotice);
  input.ipcMain.handle(DESKTOP_SESSION_TIMEZONE_SETTING_CHANNEL, onSetting);
  input.ipcMain.handle(DESKTOP_SESSION_TIMEZONE_MODE_CHANNEL, onChooseMode);
  let installed = true;
  return () => {
    if (!installed) return;
    installed = false;
    input.ipcMain.removeHandler(DESKTOP_SESSION_TIMEZONE_NOTICE_CHANNEL);
    input.ipcMain.removeHandler(DESKTOP_SESSION_TIMEZONE_SETTING_CHANNEL);
    input.ipcMain.removeHandler(DESKTOP_SESSION_TIMEZONE_MODE_CHANNEL);
  };
}
