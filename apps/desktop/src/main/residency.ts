import {
  Menu,
  Tray,
  nativeImage,
  type App,
  type BrowserWindow,
  type MenuItemConstructorOptions,
} from "electron";
import {
  readLoginItemResidency,
  setLoginItemResidency,
  type LoginItemResidencyState,
} from "./login-item.js";
import { createTrayPopover, type TrayPopover } from "./tray-popover.js";

export const TRAY_TOOLTIP = "Enduragent" as const;
export const TRAY_POPOVER_WIDTH = 420 as const;
export const TRAY_POPOVER_HEIGHT = 246 as const;
export const TRAY_POPOVER_GAP = 6 as const;
export const TRAY_POPOVER_EDGE_INSET = 8 as const;

export interface MainWindowResidencyPort {
  current(): BrowserWindow | null;
  show(): Promise<BrowserWindow>;
}

export type DesktopResidencyEvent =
  | { readonly type: "tray-created" }
  | { readonly type: "tray-destroyed" }
  | { readonly type: "popover-shown" }
  | { readonly type: "popover-hidden" }
  | { readonly type: "main-window-shown" }
  | { readonly type: "login-item-read"; readonly state: LoginItemResidencyState }
  | { readonly type: "login-item-set"; readonly state: LoginItemResidencyState };

export interface DesktopResidencyInput {
  readonly app: App;
  readonly mainWindow: MainWindowResidencyPort;
  readonly trayIconPath: string;
  readonly trayPopoverUrl: string;
  readonly reportFailure: (
    operation: "read-login-item" | "set-login-item" | "show-window" | "tray-start",
  ) => void;
  readonly observe?: (event: DesktopResidencyEvent) => void;
}

export interface DesktopResidency {
  start(): Promise<void>;
  showMainWindow(): Promise<void>;
  quit(): void;
  close(): void;
}

export function createDesktopResidency(input: DesktopResidencyInput): DesktopResidency {
  let tray: Tray | undefined;
  let popover: TrayPopover | undefined;
  let startPromise: Promise<void> | undefined;
  let quitRequested = false;
  let closed = false;

  const hidePopover = (): void => popover?.hide();
  const showMainWindow = async (): Promise<void> => {
    hidePopover();
    try {
      await input.mainWindow.show();
      input.observe?.({ type: "main-window-shown" });
    } catch {
      input.reportFailure("show-window");
    }
  };
  const ensurePopover = (): TrayPopover => {
    if (popover !== undefined) return popover;
    if (tray === undefined) throw new TypeError();
    popover = createTrayPopover({
      url: input.trayPopoverUrl,
      getTrayBounds: () => tray?.getBounds() ?? { x: 0, y: 0, width: 0, height: 0 },
    });
    popover.window.on("show", () => input.observe?.({ type: "popover-shown" }));
    popover.window.on("hide", () => input.observe?.({ type: "popover-hidden" }));
    return popover;
  };
  const readLoginState = (): LoginItemResidencyState | undefined => {
    try {
      const state = readLoginItemResidency(input.app);
      input.observe?.({ type: "login-item-read", state });
      return state;
    } catch {
      input.reportFailure("read-login-item");
      return undefined;
    }
  };
  const setLoginState = (openAtLogin: boolean): void => {
    try {
      const state = setLoginItemResidency(input.app, openAtLogin);
      input.observe?.({ type: "login-item-set", state });
    } catch {
      input.reportFailure("set-login-item");
      readLoginState();
    }
  };
  const showContextMenu = (): void => {
    if (tray === undefined) return;
    const state = readLoginState();
    const template: MenuItemConstructorOptions[] = [
      {
        label: "Open Enduragent",
        click: () => void showMainWindow(),
      },
      { type: "separator" },
      {
        label: "Start in background at login",
        type: "checkbox",
        checked: state?.openAtLogin ?? false,
        enabled: state !== undefined,
        click: (menuItem) => setLoginState(menuItem.checked),
      },
      { type: "separator" },
      {
        label: "Quit Enduragent",
        click: () => residency.quit(),
      },
    ];
    tray.popUpContextMenu(Menu.buildFromTemplate(template));
  };
  const residency: DesktopResidency = {
    start() {
      startPromise ??= Promise.resolve()
        .then(() => {
          if (closed || tray !== undefined) return;
          const image = nativeImage.createFromPath(input.trayIconPath);
          if (image.isEmpty()) throw new TypeError();
          image.setTemplateImage(true);
          tray = new Tray(image);
          tray.setToolTip(TRAY_TOOLTIP);
          tray.on("click", () => ensurePopover().toggle());
          tray.on("right-click", showContextMenu);
          input.observe?.({ type: "tray-created" });
        })
        .catch(() => {
          input.reportFailure("tray-start");
        });
      return startPromise;
    },
    showMainWindow,
    quit() {
      if (quitRequested) return;
      quitRequested = true;
      input.app.quit();
    },
    close() {
      if (closed) return;
      closed = true;
      popover?.close();
      popover = undefined;
      if (tray !== undefined) {
        tray.removeAllListeners();
        tray.destroy();
        tray = undefined;
        input.observe?.({ type: "tray-destroyed" });
      }
    },
  };
  return residency;
}
