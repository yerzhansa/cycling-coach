import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  BrowserWindow: class {},
  net: { fetch: vi.fn() },
  protocol: { registerSchemesAsPrivileged: vi.fn() },
}));

import { DESKTOP_OPEN_EXTERNAL_CHANNEL } from "../src/main/constants.js";
import { installDesktopExternalLinkIpc } from "../src/main/external-link-ipc.js";
import { createDesktopRendererUrl } from "../src/main/renderer-navigation.js";

const RENDERER_URL = createDesktopRendererUrl("A".repeat(43));

type Listener = (event: unknown, ...args: unknown[]) => void;

function setup(openExternal = vi.fn(async () => {})) {
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
  const mainFrame: { url: string } = { url: RENDERER_URL };
  const webContents = { isDestroyed: () => false, mainFrame };
  const window = { isDestroyed: () => false, webContents };
  let currentWindow: typeof window | undefined = window;
  const dispose = installDesktopExternalLinkIpc({
    ipcMain: ipcMain as never,
    currentWindow: () => currentWindow as never,
    openExternal,
  });
  const emit = (event: unknown, ...args: unknown[]): void => {
    for (const listener of listeners.get(DESKTOP_OPEN_EXTERNAL_CHANNEL) ?? []) {
      listener(event, ...args);
    }
  };
  return {
    dispose,
    emit,
    ipcMain,
    listeners,
    mainFrame,
    openExternal,
    setCurrentWindow(value: typeof window | undefined) {
      currentWindow = value;
    },
    trusted: { sender: webContents, senderFrame: mainFrame },
    webContents,
    window,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("desktop external-link IPC", () => {
  it("opens canonical credential-free HTTP links from the trusted main frame", async () => {
    const { emit, openExternal, trusted } = setup();

    emit(trusted, "https://example.test/guide");
    emit(trusted, "http://example.test/guide?a=1&b=2");
    await Promise.resolve();

    expect(openExternal.mock.calls).toEqual([
      ["https://example.test/guide"],
      ["http://example.test/guide?a=1&b=2"],
    ]);
  });

  it("requires exactly one string argument before opening", () => {
    const { emit, openExternal, trusted } = setup();

    emit(trusted);
    emit(trusted, "https://example.test/", "extra");
    emit(trusted, { url: "https://example.test/" });
    emit(trusted, null);

    expect(openExternal).not.toHaveBeenCalled();
  });

  it.each([
    "HTTPS://EXAMPLE.TEST:443/guide",
    "https://user@example.test/guide",
    "https://user:secret@example.test/guide",
    " https://example.test/guide",
    "https://example.test/guide\u007f",
    "https://example.test/guide\nnext",
    "javascript:alert(1)",
    "data:text/plain,unsafe",
    "enduragent://app/index.html",
    "/relative",
    "http://",
  ])("rejects a noncanonical or unsafe destination: %s", (url) => {
    const { emit, openExternal, trusted } = setup();

    emit(trusted, url);

    expect(openExternal).not.toHaveBeenCalled();
  });

  it("rejects stale, subframe, mismatched-sender, and destroyed-window events", () => {
    const state = setup();
    const otherFrame = { url: RENDERER_URL };

    state.emit(
      { sender: state.webContents, senderFrame: otherFrame },
      "https://example.test/guide",
    );
    state.emit({ sender: {}, senderFrame: state.mainFrame }, "https://example.test/guide");
    state.emit({ sender: state.webContents, senderFrame: null }, "https://example.test/guide");
    state.mainFrame.url = "https://example.invalid";
    state.emit(state.trusted, "https://example.test/guide");
    state.mainFrame.url = RENDERER_URL;
    state.setCurrentWindow(undefined);
    state.emit(state.trusted, "https://example.test/guide");
    state.setCurrentWindow({ ...state.window, isDestroyed: () => true });
    state.emit(state.trusted, "https://example.test/guide");
    state.setCurrentWindow({
      ...state.window,
      webContents: { ...state.webContents, isDestroyed: () => true },
    });
    state.emit(state.trusted, "https://example.test/guide");

    expect(state.openExternal).not.toHaveBeenCalled();
  });

  it("contains synchronous and asynchronous opener failures", async () => {
    const syncFailure = vi.fn(() => {
      throw new Error("synthetic synchronous failure");
    });
    const sync = setup(syncFailure as never);
    expect(() => sync.emit(sync.trusted, "https://example.test/guide")).not.toThrow();

    const asyncFailure = vi.fn(async () => Promise.reject(new Error("synthetic rejection")));
    const asynchronous = setup(asyncFailure);
    expect(() =>
      asynchronous.emit(asynchronous.trusted, "https://example.test/guide"),
    ).not.toThrow();
    await Promise.resolve();

    expect(syncFailure).toHaveBeenCalledOnce();
    expect(asyncFailure).toHaveBeenCalledOnce();
  });

  it("removes only its exact listener during shutdown", () => {
    const { dispose, ipcMain, listeners } = setup();
    const listener = [...listeners.get(DESKTOP_OPEN_EXTERNAL_CHANNEL)!][0]!;

    dispose();
    dispose();

    expect(ipcMain.removeListener).toHaveBeenCalledOnce();
    expect(ipcMain.removeListener).toHaveBeenCalledWith(DESKTOP_OPEN_EXTERNAL_CHANNEL, listener);
    expect(listeners.get(DESKTOP_OPEN_EXTERNAL_CHANNEL)).toEqual(new Set());
  });
});
