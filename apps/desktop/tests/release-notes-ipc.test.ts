import { beforeEach, describe, expect, it, vi } from "vitest";

const coreMocks = vi.hoisted(() => ({
  fetchLatestReleaseNotes: vi.fn(),
}));

vi.mock("electron", () => ({
  BrowserWindow: class {},
  net: { fetch: vi.fn() },
  protocol: { registerSchemesAsPrivileged: vi.fn() },
}));
vi.mock("@enduragent/core", () => ({
  fetchLatestReleaseNotes: coreMocks.fetchLatestReleaseNotes,
}));

import { DESKTOP_RELEASE_NOTES_CHANNEL } from "../src/main/constants.js";
import { installDesktopReleaseNotesIpc } from "../src/main/release-notes-ipc.js";
import { createDesktopRendererUrl } from "../src/main/renderer-navigation.js";

const RENDERER_URL = createDesktopRendererUrl("A".repeat(43));

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
type LoadReleaseNotes = (...args: unknown[]) => Promise<unknown>;

const availableResult = {
  status: "available",
  version: "2026.7.23",
  notes: ["Added release notes to the desktop."],
  releaseUrl: "https://github.com/yerzhansa/enduragent/releases/tag/cycling-coach@2026.7.23",
} as const;

function setup(loadReleaseNotes: LoadReleaseNotes = vi.fn(async () => availableResult)) {
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: vi.fn((channel: string, handler: Handler) => handlers.set(channel, handler)),
    removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
  };
  const mainFrame: { url: string } = { url: RENDERER_URL };
  const webContents = { isDestroyed: () => false, mainFrame };
  const window = { isDestroyed: () => false, webContents };
  let currentWindow: typeof window | undefined = window;
  const dispose = installDesktopReleaseNotesIpc({
    ipcMain: ipcMain as never,
    currentWindow: () => currentWindow as never,
    loadReleaseNotes: loadReleaseNotes as never,
  });
  return {
    dispose,
    handlers,
    ipcMain,
    loadReleaseNotes,
    mainFrame,
    setCurrentWindow(value: typeof window | undefined) {
      currentWindow = value;
    },
    trusted: { sender: webContents, senderFrame: mainFrame },
    webContents,
    window,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("desktop release notes IPC", () => {
  it("loads the fixed binary and repository for a trusted zero-argument request", async () => {
    const state = setup();
    const releaseNotes = state.handlers.get(DESKTOP_RELEASE_NOTES_CHANNEL)!;

    await expect(releaseNotes(state.trusted)).resolves.toEqual(availableResult);
    expect(state.loadReleaseNotes).toHaveBeenCalledOnce();
    expect(state.loadReleaseNotes).toHaveBeenCalledWith("cycling-coach", {
      owner: "yerzhansa",
      name: "enduragent",
    });
  });

  it("returns a closed copy of an available result", async () => {
    const notes = ["First athlete-facing change."];
    const loadReleaseNotes = vi.fn(async () => ({
      status: "available" as const,
      version: "2026.7.23",
      notes,
      releaseUrl: "https://github.com/yerzhansa/enduragent/releases/tag/cycling-coach@2026.7.23",
      internalFeedUrl: "https://example.invalid/private-feed",
    }));
    const state = setup(loadReleaseNotes);

    const result = (await state.handlers.get(DESKTOP_RELEASE_NOTES_CHANNEL)!(state.trusted)) as {
      readonly notes: readonly string[];
    };

    expect(Object.keys(result).sort()).toEqual(["notes", "releaseUrl", "status", "version"]);
    expect(result.notes).toEqual(notes);
    expect(result.notes).not.toBe(notes);
    expect(result).not.toHaveProperty("internalFeedUrl");
  });

  it("coalesces only concurrent invocations and retries after settlement", async () => {
    let resolveFirst!: (value: typeof availableResult) => void;
    const firstLoad = new Promise<typeof availableResult>((resolve) => {
      resolveFirst = resolve;
    });
    const loadReleaseNotes = vi
      .fn()
      .mockReturnValueOnce(firstLoad)
      .mockResolvedValueOnce(availableResult);
    const state = setup(loadReleaseNotes);
    const releaseNotes = state.handlers.get(DESKTOP_RELEASE_NOTES_CHANNEL)!;

    const first = releaseNotes(state.trusted);
    const concurrent = releaseNotes(state.trusted);
    expect(concurrent).toBe(first);
    expect(loadReleaseNotes).toHaveBeenCalledOnce();

    resolveFirst(availableResult);
    await expect(first).resolves.toEqual(availableResult);
    await expect(releaseNotes(state.trusted)).resolves.toEqual(availableResult);
    expect(loadReleaseNotes).toHaveBeenCalledTimes(2);
  });

  it("contains loader failures and retries the next request", async () => {
    const loadReleaseNotes = vi
      .fn()
      .mockRejectedValueOnce(new Error("secret path /private/synthetic"))
      .mockResolvedValueOnce(availableResult);
    const state = setup(loadReleaseNotes);
    const releaseNotes = state.handlers.get(DESKTOP_RELEASE_NOTES_CHANNEL)!;

    await expect(releaseNotes(state.trusted)).resolves.toEqual({
      status: "unavailable",
      version: null,
      releaseUrl: "https://github.com/yerzhansa/enduragent/releases",
    });
    await expect(releaseNotes(state.trusted)).resolves.toEqual(availableResult);
    expect(loadReleaseNotes).toHaveBeenCalledTimes(2);
  });

  it("refuses untrusted, stale, subframe, and wrong-origin senders", async () => {
    const state = setup();
    const releaseNotes = state.handlers.get(DESKTOP_RELEASE_NOTES_CHANNEL)!;
    const subframe = { url: RENDERER_URL };

    expect(() => releaseNotes({ sender: state.webContents, senderFrame: subframe })).toThrow(
      "untrusted desktop release notes request",
    );
    expect(() => releaseNotes({ sender: {}, senderFrame: state.mainFrame })).toThrow(
      "untrusted desktop release notes request",
    );
    state.mainFrame.url = "https://example.invalid";
    expect(() => releaseNotes(state.trusted)).toThrow("untrusted desktop release notes request");
    state.mainFrame.url = RENDERER_URL;
    state.setCurrentWindow(undefined);
    expect(() => releaseNotes(state.trusted)).toThrow("untrusted desktop release notes request");

    expect(state.loadReleaseNotes).not.toHaveBeenCalled();
  });

  it("rejects every argument without loading release notes", async () => {
    const state = setup();
    const releaseNotes = state.handlers.get(DESKTOP_RELEASE_NOTES_CHANNEL)!;

    for (const args of [[undefined], [{}], ["extra"], [1, 2]]) {
      expect(() => releaseNotes(state.trusted, ...args)).toThrow(
        "invalid desktop release notes request",
      );
    }
    expect(state.loadReleaseNotes).not.toHaveBeenCalled();
  });

  it("removes its handler exactly once during shutdown", () => {
    const state = setup();
    state.handlers.set("synthetic:unrelated", vi.fn());

    state.dispose();
    state.dispose();

    expect(state.ipcMain.removeHandler).toHaveBeenCalledOnce();
    expect(state.ipcMain.removeHandler).toHaveBeenCalledWith(DESKTOP_RELEASE_NOTES_CHANNEL);
    expect(state.handlers.has(DESKTOP_RELEASE_NOTES_CHANNEL)).toBe(false);
    expect(state.handlers.has("synthetic:unrelated")).toBe(true);
  });
});
