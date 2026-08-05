import { isAbsolute } from "node:path";
import { BrowserWindow, screen, type Point, type Rectangle } from "electron";
import { DESKTOP_TRAY_TELEGRAM_STATUS_CHANNEL } from "./constants.js";
import {
  TRAY_POPOVER_EDGE_INSET,
  TRAY_POPOVER_GAP,
  TRAY_POPOVER_HEIGHT,
  TRAY_POPOVER_WIDTH,
} from "./residency.js";

export interface TrayPopoverPositionInput {
  readonly trayBounds: Rectangle;
  readonly popoverSize: Pick<Rectangle, "width" | "height">;
  readonly workArea: Rectangle;
}

export function calculateTrayPopoverPosition(input: TrayPopoverPositionInput): Point {
  const minimumX = input.workArea.x + TRAY_POPOVER_EDGE_INSET;
  const maximumX =
    input.workArea.x + input.workArea.width - input.popoverSize.width - TRAY_POPOVER_EDGE_INSET;
  const centeredX = input.trayBounds.x + input.trayBounds.width / 2 - input.popoverSize.width / 2;
  const belowY = input.trayBounds.y + input.trayBounds.height + TRAY_POPOVER_GAP;
  const workAreaBottom = input.workArea.y + input.workArea.height;
  const y =
    belowY + input.popoverSize.height <= workAreaBottom
      ? belowY
      : input.trayBounds.y - input.popoverSize.height - TRAY_POPOVER_GAP;
  return {
    x: Math.round(Math.min(Math.max(centeredX, minimumX), maximumX)),
    y: Math.round(y),
  };
}

export interface TrayPopover {
  readonly window: BrowserWindow;
  publishTelegramStatus(status: unknown): void;
  toggle(): void;
  hide(): void;
  close(): void;
}

export function createTrayPopover(input: {
  readonly url: string;
  readonly preload: string;
  readonly getTrayBounds: () => Rectangle;
}): TrayPopover {
  if (!isAbsolute(input.preload)) throw new TypeError("tray preload path must be absolute");
  const window = new BrowserWindow({
    width: TRAY_POPOVER_WIDTH,
    height: TRAY_POPOVER_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: true,
    webPreferences: {
      preload: input.preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  let closing = false;
  let loaded = false;
  let pendingTelegramStatus: unknown;
  const sendTelegramStatus = (): void => {
    if (!loaded || pendingTelegramStatus === undefined || window.isDestroyed()) return;
    window.webContents.send(DESKTOP_TRAY_TELEGRAM_STATUS_CHANNEL, pendingTelegramStatus);
  };
  const hide = (): void => {
    if (!window.isDestroyed() && window.isVisible()) window.hide();
  };
  const preventClose = (event: Electron.Event): void => {
    if (closing) return;
    event.preventDefault();
    hide();
  };
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("did-finish-load", () => {
    loaded = true;
    sendTelegramStatus();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.on("blur", hide);
  window.on("close", preventClose);
  void window.loadURL(input.url);
  return {
    window,
    publishTelegramStatus(status) {
      pendingTelegramStatus = status;
      sendTelegramStatus();
    },
    toggle() {
      if (window.isDestroyed()) return;
      if (window.isVisible()) {
        hide();
        return;
      }
      const trayBounds = input.getTrayBounds();
      const workArea = screen.getDisplayMatching(trayBounds).workArea;
      const position = calculateTrayPopoverPosition({
        trayBounds,
        popoverSize: { width: TRAY_POPOVER_WIDTH, height: TRAY_POPOVER_HEIGHT },
        workArea,
      });
      window.setPosition(position.x, position.y, false);
      window.show();
    },
    hide,
    close() {
      if (closing) return;
      closing = true;
      hide();
      window.removeListener("close", preventClose);
      window.removeListener("blur", hide);
      if (!window.isDestroyed()) window.destroy();
    },
  };
}
