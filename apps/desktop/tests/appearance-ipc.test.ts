import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  BrowserWindow: class {},
  net: { fetch: vi.fn() },
  protocol: { registerSchemesAsPrivileged: vi.fn() },
}));

import { installDesktopAppearanceIpc } from "../src/main/appearance-ipc.js";
import {
  desktopWindowBackgroundColor,
  parseDesktopAppearance,
} from "../src/main/appearance.js";
import {
  DESKTOP_APPEARANCE_CHANNEL,
  DESKTOP_RENDERER_URL,
  DESKTOP_WINDOW_DARK_BACKGROUND,
  DESKTOP_WINDOW_LIGHT_BACKGROUND,
} from "../src/main/constants.js";

type Listener = (event: unknown, ...args: unknown[]) => void;

function setup(
  applyThemeSource = vi.fn((appearance: string) => (appearance === "dark" ? "dark" : "light")),
) {
  const listeners = new Map<string, Set<Listener>>();
  const ipcMain = {
    on: vi.fn((channel: string, listener: Listener) => {
      const channelListeners = listeners.get(channel) ?? new Set();
      channelListeners.add(listener);
      listeners.set(channel, channelListeners);
    }),
    removeListener: vi.fn((channel: string, listener: Listener) => {
      listeners.get(channel)?.delete(listener);
    }),
  };
  const mainFrame: { url: string } = { url: DESKTOP_RENDERER_URL };
  const setBackgroundColor = vi.fn();
  const webContents = { isDestroyed: () => false, mainFrame };
  const window = { isDestroyed: () => false, webContents, setBackgroundColor };
  let currentWindow: typeof window | undefined = window;
  const dispose = installDesktopAppearanceIpc({
    ipcMain: ipcMain as never,
    currentWindow: () => currentWindow as never,
    applyThemeSource: applyThemeSource as never,
  });
  const emit = (event: unknown, ...args: unknown[]): void => {
    for (const listener of listeners.get(DESKTOP_APPEARANCE_CHANNEL) ?? []) {
      listener(event, ...args);
    }
  };
  return {
    applyThemeSource,
    dispose,
    emit,
    ipcMain,
    listeners,
    mainFrame,
    setBackgroundColor,
    setCurrentWindow(value: typeof window | undefined) {
      currentWindow = value;
    },
    trusted: { sender: webContents, senderFrame: mainFrame },
    webContents,
    window,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("desktop appearance IPC", () => {
  it("forwards each supported appearance to the native theme source", () => {
    const { applyThemeSource, emit, trusted } = setup();

    emit(trusted, "system");
    emit(trusted, "light");
    emit(trusted, "dark");

    expect(applyThemeSource.mock.calls).toEqual([["system"], ["light"], ["dark"]]);
  });

  it("repaints the window with the background of the resolved theme", () => {
    const { emit, setBackgroundColor, trusted } = setup();

    emit(trusted, "dark");
    emit(trusted, "light");
    emit(trusted, "system");

    expect(setBackgroundColor.mock.calls).toEqual([
      [DESKTOP_WINDOW_DARK_BACKGROUND],
      [DESKTOP_WINDOW_LIGHT_BACKGROUND],
      [DESKTOP_WINDOW_LIGHT_BACKGROUND],
    ]);
  });

  it("follows the operating system when the resolved theme is dark under system", () => {
    const applyThemeSource = vi.fn(() => "dark");
    const { emit, setBackgroundColor, trusted } = setup(applyThemeSource as never);

    emit(trusted, "system");

    expect(setBackgroundColor).toHaveBeenCalledWith(DESKTOP_WINDOW_DARK_BACKGROUND);
  });

  it.each([
    "Dark",
    "DARK",
    "auto",
    "",
    "system ",
    "__proto__",
    0,
    null,
    undefined,
    { appearance: "dark" },
    ["dark"],
  ])("rejects an appearance outside the three supported values: %s", (value) => {
    const { applyThemeSource, emit, setBackgroundColor, trusted } = setup();

    emit(trusted, value);

    expect(applyThemeSource).not.toHaveBeenCalled();
    expect(setBackgroundColor).not.toHaveBeenCalled();
  });

  it("requires exactly one argument", () => {
    const { applyThemeSource, emit, trusted } = setup();

    emit(trusted);
    emit(trusted, "dark", "extra");

    expect(applyThemeSource).not.toHaveBeenCalled();
  });

  it("rejects stale, subframe, mismatched-sender, and destroyed-window events", () => {
    const state = setup();
    const otherFrame = { url: DESKTOP_RENDERER_URL };

    state.emit({ sender: state.webContents, senderFrame: otherFrame }, "dark");
    state.emit({ sender: {}, senderFrame: state.mainFrame }, "dark");
    state.emit({ sender: state.webContents, senderFrame: null }, "dark");
    state.mainFrame.url = "https://example.invalid";
    state.emit(state.trusted, "dark");
    state.mainFrame.url = DESKTOP_RENDERER_URL;
    state.setCurrentWindow(undefined);
    state.emit(state.trusted, "dark");
    state.setCurrentWindow({ ...state.window, isDestroyed: () => true });
    state.emit(state.trusted, "dark");
    state.setCurrentWindow({
      ...state.window,
      webContents: { ...state.webContents, isDestroyed: () => true },
    });
    state.emit(state.trusted, "dark");

    expect(state.applyThemeSource).not.toHaveBeenCalled();
    expect(state.setBackgroundColor).not.toHaveBeenCalled();
  });

  it("contains a failing native theme assignment", () => {
    const failing = vi.fn(() => {
      throw new Error("synthetic native theme failure");
    });
    const state = setup(failing as never);

    expect(() => state.emit(state.trusted, "dark")).not.toThrow();
    expect(state.setBackgroundColor).not.toHaveBeenCalled();
  });

  it("removes only its exact listener during shutdown", () => {
    const { dispose, ipcMain, listeners } = setup();
    const listener = [...listeners.get(DESKTOP_APPEARANCE_CHANNEL)!][0]!;

    dispose();
    dispose();

    expect(ipcMain.removeListener).toHaveBeenCalledOnce();
    expect(ipcMain.removeListener).toHaveBeenCalledWith(DESKTOP_APPEARANCE_CHANNEL, listener);
    expect(listeners.get(DESKTOP_APPEARANCE_CHANNEL)).toEqual(new Set());
  });

  it("parses only the three supported appearances", () => {
    expect(parseDesktopAppearance("system")).toBe("system");
    expect(parseDesktopAppearance("light")).toBe("light");
    expect(parseDesktopAppearance("dark")).toBe("dark");
    expect(parseDesktopAppearance("Dark")).toBeUndefined();
    expect(parseDesktopAppearance(undefined)).toBeUndefined();
    expect(desktopWindowBackgroundColor("dark")).toBe(DESKTOP_WINDOW_DARK_BACKGROUND);
    expect(desktopWindowBackgroundColor("light")).toBe(DESKTOP_WINDOW_LIGHT_BACKGROUND);
  });
});
