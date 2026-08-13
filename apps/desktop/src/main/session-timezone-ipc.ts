import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import {
  DESKTOP_SESSION_TIMEZONE_NOTICE_CHANNEL,
  DESKTOP_SESSION_TIMEZONE_RECORD_CHANNEL,
} from "./constants.js";
import { isTrustedConnectionRequest } from "./security.js";
import {
  NO_SESSION_TIMEZONE_NOTICE,
  parseSessionTimezoneSource,
  type DesktopSessionTimezoneNotice,
  type SessionTimezoneSource,
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
  readonly record: (source: SessionTimezoneSource) => Promise<boolean>;
}): () => void {
  const onNotice = (event: IpcMainInvokeEvent, ...args: unknown[]): DesktopSessionTimezoneNotice => {
    if (!isTrustedConnectionRequest(event, input.currentWindow())) {
      throw new Error("untrusted desktop session timezone request");
    }
    if (args.length !== 0) throw new TypeError("invalid desktop session timezone request");
    return input.notices.read();
  };

  const onRecord = async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<boolean> => {
    if (!isTrustedConnectionRequest(event, input.currentWindow())) {
      throw new Error("untrusted desktop session timezone request");
    }
    if (args.length !== 1) throw new TypeError("invalid desktop session timezone request");
    const source = parseSessionTimezoneSource(args[0]);
    if (source === undefined) throw new TypeError("invalid desktop session timezone source");
    const recorded = await input.record(source);
    if (recorded) input.notices.clear();
    return recorded;
  };

  input.ipcMain.handle(DESKTOP_SESSION_TIMEZONE_NOTICE_CHANNEL, onNotice);
  input.ipcMain.handle(DESKTOP_SESSION_TIMEZONE_RECORD_CHANNEL, onRecord);
  let installed = true;
  return () => {
    if (!installed) return;
    installed = false;
    input.ipcMain.removeHandler(DESKTOP_SESSION_TIMEZONE_NOTICE_CHANNEL);
    input.ipcMain.removeHandler(DESKTOP_SESSION_TIMEZONE_RECORD_CHANNEL);
  };
}
