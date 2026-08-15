import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  BrowserWindow: class {},
  net: { fetch: vi.fn() },
  protocol: { registerSchemesAsPrivileged: vi.fn() },
}));

import { installDesktopConnectionIpc } from "../src/main/connection-ipc.js";
import {
  DESKTOP_CONNECTION_CHANNEL,
  DESKTOP_INITIAL_SETUP_STATUS_SETTLED_CHANNEL,
  DESKTOP_RENDERER_URL,
} from "../src/main/constants.js";

type Handler = (event: unknown, request?: unknown) => unknown;

function capability(fill: string, suffix = "A"): string {
  return `${fill.repeat(42)}${suffix}`;
}

function setup(athleteHome = "/synthetic/athlete") {
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: vi.fn((channel: string, handler: Handler) => handlers.set(channel, handler)),
    removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
  };
  const mainFrame = { url: DESKTOP_RENDERER_URL };
  const webContents = { isDestroyed: () => false, mainFrame };
  const window = { isDestroyed: () => false, webContents };
  let connection: {
    url: `ws://127.0.0.1:${number}/rpc`;
    token: string;
    athleteHome: string;
    rendererCapability: string;
    owner: "app-supervised";
    supervision: "app-supervised";
    generation: number;
  } = {
    url: "ws://127.0.0.1:45001/rpc" as const,
    token: "s".repeat(43),
    athleteHome,
    rendererCapability: capability("r"),
    owner: "app-supervised",
    supervision: "app-supervised",
    generation: 1,
  };
  const runtime = {
    connection: vi.fn(() => connection),
    recover: vi.fn(async (generation: number) => {
      if (generation < connection.generation) return connection;
      connection = {
        url: "ws://127.0.0.1:45002/rpc" as const,
        token: "t".repeat(43),
        athleteHome,
        rendererCapability: capability("q"),
        owner: "app-supervised",
        supervision: "app-supervised",
        generation: 2,
      };
      return connection;
    }),
  };
  const initialSetupStatusSettled = vi.fn(async () => {});
  const dispose = installDesktopConnectionIpc({
    ipcMain: ipcMain as never,
    currentWindow: () => window as never,
    expectedAthleteHome: "/synthetic/athlete",
    runtime,
    initialSetupStatusSettled,
  });
  const trusted = { sender: webContents, senderFrame: mainFrame };
  return { dispose, handlers, ipcMain, runtime, initialSetupStatusSettled, trusted };
}

beforeEach(() => vi.clearAllMocks());

describe("desktop connection IPC", () => {
  it("reads current coordinates again after a successful recovery", async () => {
    const { handlers, runtime, trusted } = setup();
    const connection = handlers.get(DESKTOP_CONNECTION_CHANNEL)!;
    expect(((await connection(trusted)) as { readonly url: string }).url).toBe(
      "ws://127.0.0.1:45001/rpc",
    );
    expect(((await connection(trusted, { generation: 1 })) as { readonly url: string }).url).toBe(
      "ws://127.0.0.1:45002/rpc",
    );
    expect(runtime.connection).toHaveBeenCalledTimes(1);
    expect(runtime.recover).toHaveBeenCalledWith(1);
    await expect(connection(trusted, { generation: 1 })).resolves.toMatchObject({ generation: 2 });
  });

  it("projects only renderer-safe coordinates on initial and recovered connections", async () => {
    const { handlers, trusted } = setup();
    const connection = handlers.get(DESKTOP_CONNECTION_CHANNEL)!;

    await expect(connection(trusted)).resolves.toEqual({
      url: "ws://127.0.0.1:45001/rpc",
      rendererCapability: capability("r"),
      generation: 1,
    });
    await expect(connection(trusted, { generation: 1 })).resolves.toEqual({
      url: "ws://127.0.0.1:45002/rpc",
      rendererCapability: capability("q"),
      generation: 2,
    });
  });

  it("refuses to publish coordinates for a different athlete home", async () => {
    const { handlers, runtime, trusted } = setup("/synthetic/other-athlete");
    const connection = handlers.get(DESKTOP_CONNECTION_CHANNEL)!;

    await expect(connection(trusted)).rejects.toThrow("desktop daemon home mismatch");
    await expect(connection(trusted, { generation: 1 })).rejects.toThrow(
      "desktop daemon home mismatch",
    );
    expect(runtime.connection).toHaveBeenCalledTimes(1);
    expect(runtime.recover).toHaveBeenCalledWith(1);
  });

  it("refuses untrusted connection and recovery requests", async () => {
    const { handlers, runtime } = setup();
    const untrusted = { sender: {}, senderFrame: { url: DESKTOP_RENDERER_URL } };
    const connection = handlers.get(DESKTOP_CONNECTION_CHANNEL)!;
    for (const request of [undefined, { generation: 1 }]) {
      await expect(connection(untrusted, request)).rejects.toThrow(
        "untrusted desktop connection request",
      );
    }
    expect(runtime.connection).not.toHaveBeenCalled();
    expect(runtime.recover).not.toHaveBeenCalled();
  });

  it("rejects malformed recovery requests before changing daemon state", async () => {
    const { handlers, runtime, trusted } = setup();
    const connection = handlers.get(DESKTOP_CONNECTION_CHANNEL)!;
    for (const request of [
      false,
      {},
      { generation: 0 },
      { generation: 1.5 },
      { generation: 1, extra: true },
    ]) {
      await expect(connection(trusted, request)).rejects.toThrow(
        "invalid desktop connection request",
      );
    }
    expect(runtime.recover).not.toHaveBeenCalled();
  });

  it("accepts only a trusted strict generation settlement", async () => {
    const { handlers, initialSetupStatusSettled, trusted } = setup();
    const settled = handlers.get(DESKTOP_INITIAL_SETUP_STATUS_SETTLED_CHANNEL)!;

    await expect(settled(trusted, { generation: 3 })).resolves.toBeUndefined();
    expect(initialSetupStatusSettled).toHaveBeenCalledWith(3);
    for (const request of [undefined, null, {}, { generation: 0 }, { generation: 1.5 }, {
      generation: 1,
      extra: true,
    }]) {
      await expect(settled(trusted, request)).rejects.toThrow(
        "invalid initial setup status settlement",
      );
    }
    await expect(
      settled({ sender: {}, senderFrame: { url: DESKTOP_RENDERER_URL } }, { generation: 3 }),
    ).rejects.toThrow("untrusted desktop connection request");
    expect(initialSetupStatusSettled).toHaveBeenCalledOnce();
  });

  it("removes the trusted connection channel during shutdown", () => {
    const { dispose, handlers, ipcMain } = setup();
    dispose();
    expect(handlers.size).toBe(0);
    expect(ipcMain.removeHandler).toHaveBeenCalledWith(DESKTOP_CONNECTION_CHANNEL);
    expect(ipcMain.removeHandler).toHaveBeenCalledWith(
      DESKTOP_INITIAL_SETUP_STATUS_SETTLED_CHANNEL,
    );
  });
});
