import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ BrowserWindow: class {} }));

import {
  createConnectionPlanningReader,
  installDesktopPlanningReadIpc,
} from "../src/main/planning-read-ipc.js";
import { DESKTOP_PLANNING_READ_CHANNEL } from "../src/main/constants.js";
import { createDesktopRendererUrl } from "../src/main/renderer-navigation.js";

const RENDERER_URL = createDesktopRendererUrl("A".repeat(43));
const model = { schemaVersion: 1 as const, status: "no-plan" as const, asOfDateKey: 20260826, plan: null };
type Handler = (event: unknown, ...args: unknown[]) => unknown;

function setup(read = vi.fn(async () => model)) {
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: vi.fn((channel: string, handler: Handler) => handlers.set(channel, handler)),
    removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
  };
  const mainFrame = { url: RENDERER_URL };
  const webContents = { isDestroyed: () => false, mainFrame };
  const window = { isDestroyed: () => false, webContents };
  const dispose = installDesktopPlanningReadIpc({
    ipcMain: ipcMain as never,
    currentWindow: () => window as never,
    read,
  });
  return { handlers, ipcMain, read, dispose, trusted: { sender: webContents, senderFrame: mainFrame } };
}

beforeEach(() => vi.clearAllMocks());

describe("Desktop Planning read IPC", () => {
  it("returns a strict projection only to the trusted renderer", async () => {
    const subject = setup();
    const handler = subject.handlers.get(DESKTOP_PLANNING_READ_CHANNEL)!;
    await expect(handler(subject.trusted)).resolves.toEqual(model);
    await expect(handler(subject.trusted, {})).rejects.toThrow("invalid desktop Planning request");
    await expect(handler({ sender: {}, senderFrame: { url: RENDERER_URL } })).rejects.toThrow(
      "untrusted desktop Planning request",
    );
    expect(subject.read).toHaveBeenCalledOnce();
  });

  it("closes the privileged Coach client after a read", async () => {
    const client = { call: vi.fn(async () => model), close: vi.fn(async () => {}) };
    const connect = vi.fn(async () => client);
    const reader = createConnectionPlanningReader(
      { url: "ws://127.0.0.1:45001/rpc", token: "s".repeat(43), athleteHome: "/athlete" },
      connect as never,
    );
    await expect(reader.getPlanningReadModel()).resolves.toEqual(model);
    expect(client.call).toHaveBeenCalledWith("getPlanningReadModel", {});
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("removes its handler", () => {
    const subject = setup();
    subject.dispose();
    expect(subject.ipcMain.removeHandler).toHaveBeenCalledWith(DESKTOP_PLANNING_READ_CHANNEL);
  });
});
