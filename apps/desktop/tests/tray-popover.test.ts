import { beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => {
  class Emitter {
    private readonly listeners = new Map<string, Set<(...args: any[]) => void>>();
    on(name: string, listener: (...args: any[]) => void) {
      const listeners = this.listeners.get(name) ?? new Set();
      listeners.add(listener);
      this.listeners.set(name, listeners);
      return this;
    }
    emit(name: string, ...args: any[]) {
      for (const listener of this.listeners.get(name) ?? []) listener(...args);
    }
    removeListener(name: string, listener: (...args: any[]) => void) {
      this.listeners.get(name)?.delete(listener);
      return this;
    }
  }
  class FakeBrowserWindow extends Emitter {
    static instances: FakeBrowserWindow[] = [];
    readonly options: unknown;
    readonly webContents = Object.assign(new Emitter(), {
      setWindowOpenHandler: vi.fn(),
    });
    readonly loadURL = vi.fn(async () => {});
    readonly setPosition = vi.fn();
    readonly showInactive = vi.fn(() => {
      this.visible = true;
      this.emit("show");
    });
    readonly hide = vi.fn(() => {
      this.visible = false;
      this.emit("hide");
    });
    readonly destroy = vi.fn(() => {
      this.destroyed = true;
    });
    private visible = false;
    private destroyed = false;
    constructor(options: unknown) {
      super();
      this.options = options;
      FakeBrowserWindow.instances.push(this);
    }
    isVisible() {
      return this.visible;
    }
    isDestroyed() {
      return this.destroyed;
    }
  }
  return {
    FakeBrowserWindow,
    getDisplayMatching: vi.fn(() => ({ workArea: { x: 0, y: 0, width: 1000, height: 800 } })),
  };
});

vi.mock("electron", () => ({
  BrowserWindow: electron.FakeBrowserWindow,
  screen: { getDisplayMatching: electron.getDisplayMatching },
}));

import { calculateTrayPopoverPosition, createTrayPopover } from "../src/main/tray-popover.js";

beforeEach(() => {
  electron.FakeBrowserWindow.instances.length = 0;
  electron.getDisplayMatching.mockClear();
});

describe("tray popover", () => {
  it("centers, rounds, clamps both edges, and chooses below or above", () => {
    expect(
      calculateTrayPopoverPosition({
        trayBounds: { x: 500, y: 0, width: 17, height: 22 },
        popoverSize: { width: 420, height: 246 },
        workArea: { x: 0, y: 0, width: 1000, height: 800 },
      }),
    ).toEqual({ x: 299, y: 28 });
    expect(
      calculateTrayPopoverPosition({
        trayBounds: { x: -20, y: 0, width: 16, height: 22 },
        popoverSize: { width: 420, height: 246 },
        workArea: { x: 0, y: 0, width: 1000, height: 800 },
      }).x,
    ).toBe(8);
    expect(
      calculateTrayPopoverPosition({
        trayBounds: { x: 990, y: 0, width: 16, height: 22 },
        popoverSize: { width: 420, height: 246 },
        workArea: { x: 0, y: 0, width: 1000, height: 800 },
      }).x,
    ).toBe(572);
    expect(
      calculateTrayPopoverPosition({
        trayBounds: { x: 400, y: 760, width: 16, height: 22 },
        popoverSize: { width: 420, height: 246 },
        workArea: { x: 0, y: 0, width: 1000, height: 800 },
      }).y,
    ).toBe(508);
  });

  it("creates one hardened zero-preload window on the matching display", () => {
    const bounds = { x: 500, y: 0, width: 16, height: 22 };
    const popover = createTrayPopover({
      url: "enduragent://app/tray.html",
      getTrayBounds: () => bounds,
    });
    expect(electron.FakeBrowserWindow.instances).toHaveLength(1);
    const window = electron.FakeBrowserWindow.instances[0]!;
    expect(window.options).toEqual({
      width: 420,
      height: 246,
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
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    });
    expect("preload" in (window.options as { webPreferences: object }).webPreferences).toBe(false);
    expect(window.loadURL).toHaveBeenCalledWith("enduragent://app/tray.html");
    const openHandler = window.webContents.setWindowOpenHandler.mock.calls[0]![0] as () => unknown;
    expect(openHandler()).toEqual({ action: "deny" });
    const navigation = { preventDefault: vi.fn() };
    window.webContents.emit("will-navigate", navigation);
    expect(navigation.preventDefault).toHaveBeenCalledOnce();
    popover.toggle();
    expect(electron.getDisplayMatching).toHaveBeenCalledWith(bounds);
    expect(window.showInactive).toHaveBeenCalledOnce();
    popover.toggle();
    expect(window.hide).toHaveBeenCalledOnce();
  });

  it("hides on blur and close before quit, then destroys once", () => {
    const popover = createTrayPopover({
      url: "enduragent://app/tray.html",
      getTrayBounds: () => ({ x: 10, y: 10, width: 16, height: 16 }),
    });
    const window = electron.FakeBrowserWindow.instances[0]!;
    popover.toggle();
    window.emit("blur");
    expect(window.hide).toHaveBeenCalledOnce();
    popover.toggle();
    const closeEvent = { preventDefault: vi.fn() };
    window.emit("close", closeEvent);
    expect(closeEvent.preventDefault).toHaveBeenCalledOnce();
    expect(window.hide).toHaveBeenCalledTimes(2);
    popover.close();
    popover.close();
    expect(window.hide).toHaveBeenCalledTimes(2);
    expect(window.destroy).toHaveBeenCalledOnce();
  });
});
