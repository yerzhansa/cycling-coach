import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const exposed: Record<string, unknown> = {};
  return {
    exposed,
    exposeInMainWorld: vi.fn((name: string, value: unknown) => {
      exposed[name] = value;
    }),
    on: vi.fn(),
    removeListener: vi.fn(),
  };
});

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: mocks.exposeInMainWorld },
  ipcRenderer: { on: mocks.on, removeListener: mocks.removeListener },
}));

interface TrayBridge {
  onTelegramStatus(listener: (status: unknown) => void): () => void;
}

let bridge: TrayBridge;

beforeAll(async () => {
  await import("../src/preload/tray.js");
  bridge = mocks.exposed.enduragentTray as TrayBridge;
});

beforeEach(() => {
  mocks.on.mockClear();
  mocks.removeListener.mockClear();
});

describe("tray preload", () => {
  it("exposes only a one-way redacted status listener", () => {
    expect(Object.keys(mocks.exposed)).toEqual(["enduragentTray"]);
    expect(Object.keys(bridge)).toEqual(["onTelegramStatus"]);
    const listener = vi.fn();
    const dispose = bridge.onTelegramStatus(listener);
    const receive = mocks.on.mock.calls[0]![1] as (_event: unknown, value: unknown) => void;

    receive(undefined, { channelState: "online", gapWarning: false });
    expect(listener).toHaveBeenCalledWith({ channelState: "online", gapWarning: false });

    for (const malformed of [
      { channelState: "online", gapWarning: false, token: "must-not-cross" },
      { channelState: "unknown", gapWarning: false },
      { channelState: "online", gapWarning: "false" },
    ]) {
      receive(undefined, malformed);
    }
    expect(listener).toHaveBeenCalledOnce();

    dispose();
    expect(mocks.removeListener).toHaveBeenCalledWith("desktop:tray:telegram-status", receive);
  });

  it("rejects a non-function listener before registering IPC", () => {
    expect(() => bridge.onTelegramStatus(null as never)).toThrow(TypeError);
    expect(mocks.on).not.toHaveBeenCalled();
  });
});
