import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  BrowserWindow: class {},
  net: { fetch: vi.fn() },
  protocol: { registerSchemesAsPrivileged: vi.fn() },
}));

import { installDesktopConnectionIpc } from "../src/main/connection-ipc.js";
import {
  DESKTOP_CONNECTION_CHANNEL,
  DESKTOP_DOCUMENT_REGISTRATION_CHANNEL,
  DESKTOP_INITIAL_SETUP_STATUS_SETTLED_CHANNEL,
  DESKTOP_RENDERER_URL,
} from "../src/main/constants.js";
import { desktopRendererNavigationToken } from "../src/main/renderer-navigation.js";

type Handler = (event: unknown, request?: unknown) => unknown;

function capability(fill: string, suffix = "A"): string {
  return `${fill.repeat(42)}${suffix}`;
}

function setup(
  athleteHome = "/synthetic/athlete",
  owner: "app-supervised" | "service-managed" = "app-supervised",
) {
  const handlers = new Map<string, Handler>();
  const listeners = new Map<string, Handler>();
  const ipcMain = {
    handle: vi.fn((channel: string, handler: Handler) => handlers.set(channel, handler)),
    on: vi.fn((channel: string, listener: Handler) => listeners.set(channel, listener)),
    removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
    removeListener: vi.fn((channel: string) => listeners.delete(channel)),
  };
  const mainFrame: { url: string } = { url: DESKTOP_RENDERER_URL };
  const webContents = { isDestroyed: () => false, mainFrame };
  const window = { isDestroyed: () => false, webContents };
  let currentWindow: typeof window | undefined = window;
  let connection: {
    url: `ws://127.0.0.1:${number}/rpc`;
    token: string;
    athleteHome: string;
    rendererCapability: string;
    owner: "app-supervised" | "service-managed";
    supervision: "app-supervised" | "attached";
    generation: number;
  } = {
    url: "ws://127.0.0.1:45001/rpc",
    token: "s".repeat(43),
    athleteHome,
    rendererCapability: capability("r"),
    owner,
    supervision: owner === "app-supervised" ? "app-supervised" : "attached",
    generation: 1,
  };
  const runtime = {
    connection: vi.fn(() => connection),
    recover: vi.fn(async (generation: number) => {
      if (generation < connection.generation) return connection;
      connection = {
        url: owner === "app-supervised" ? "ws://127.0.0.1:45002/rpc" : connection.url,
        token: "t".repeat(43),
        athleteHome,
        rendererCapability: capability("q"),
        owner,
        supervision: owner === "app-supervised" ? "app-supervised" : "attached",
        generation: 2,
      };
      return connection;
    }),
  };
  const initialSetupStatusSettled = vi.fn(async () => {});
  const controller = installDesktopConnectionIpc({
    ipcMain: ipcMain as never,
    currentWindow: () => currentWindow as never,
    expectedAthleteHome: "/synthetic/athlete",
    runtime,
    initialSetupStatusSettled,
  });
  const trusted = { sender: webContents, senderFrame: mainFrame };
  const prepare = (generation: number) => {
    const url = controller.prepareDocumentNavigation(window as never, generation);
    const navigationToken = desktopRendererNavigationToken(url);
    if (navigationToken === undefined) throw new Error("prepared navigation token missing");
    return { navigationToken, url };
  };
  const commit = (url: string): void => {
    mainFrame.url = url;
  };
  const register = (navigationToken: string, event: Record<string, unknown> = trusted): unknown => {
    let returnValue: unknown;
    let returnSet = false;
    const synchronousEvent = {
      ...event,
      get returnValue(): unknown {
        return returnValue;
      },
      set returnValue(value: unknown) {
        if (returnSet) return;
        returnSet = true;
        returnValue = value;
      },
    };
    listeners.get(DESKTOP_DOCUMENT_REGISTRATION_CHANNEL)!(synchronousEvent, {
      navigationToken,
    });
    return synchronousEvent.returnValue;
  };
  return {
    commit,
    controller,
    handlers,
    initialSetupStatusSettled,
    ipcMain,
    listeners,
    prepare,
    register,
    runtime,
    setCurrentWindow: (next: typeof window | undefined) => {
      currentWindow = next;
    },
    trusted,
    window,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("desktop connection IPC", () => {
  it("rejects document calls until the main-prepared navigation registers", async () => {
    const { commit, handlers, prepare, register, runtime, trusted } = setup();
    const getConnection = handlers.get(DESKTOP_CONNECTION_CHANNEL)!;
    const prepared = prepare(1);

    expect(prepared.url).toBe(
      `${DESKTOP_RENDERER_URL}?navigationToken=${prepared.navigationToken}`,
    );
    commit(prepared.url);
    await expect(
      getConnection(trusted, { navigationToken: prepared.navigationToken }),
    ).rejects.toThrow("desktop document binding mismatch");
    expect(runtime.connection).not.toHaveBeenCalled();

    expect(register(prepared.navigationToken)).toBe(true);
    await expect(
      getConnection(trusted, { navigationToken: prepared.navigationToken }),
    ).resolves.toEqual({
      url: "ws://127.0.0.1:45001/rpc",
      rendererCapability: capability("r"),
      generation: 1,
    });
  });

  it("invalidates gen1 registration, connection, recovery, and settlement when gen2 prepares", async () => {
    const { commit, handlers, initialSetupStatusSettled, prepare, register, trusted } = setup();
    const getConnection = handlers.get(DESKTOP_CONNECTION_CHANNEL)!;
    const settle = handlers.get(DESKTOP_INITIAL_SETUP_STATUS_SETTLED_CHANNEL)!;
    const first = prepare(1);
    commit(first.url);
    expect(register(first.navigationToken)).toBe(true);

    const second = prepare(2);
    expect(register(first.navigationToken)).toBe(false);
    await expect(
      getConnection(trusted, { navigationToken: first.navigationToken }),
    ).rejects.toThrow("desktop document binding mismatch");
    await expect(
      getConnection(trusted, { navigationToken: first.navigationToken, generation: 1 }),
    ).rejects.toThrow("desktop document binding mismatch");
    await expect(
      settle(trusted, { navigationToken: first.navigationToken, generation: 1 }),
    ).rejects.toThrow("desktop document binding mismatch");

    commit(second.url);
    expect(register(second.navigationToken)).toBe(true);
    await expect(
      settle(trusted, { navigationToken: second.navigationToken, generation: 2 }),
    ).resolves.toBeUndefined();
    expect(initialSetupStatusSettled).toHaveBeenCalledOnce();
    expect(initialSetupStatusSettled).toHaveBeenCalledWith(2);
  });

  it("rejects an in-flight recovery after replacement navigation prepares", async () => {
    const { commit, handlers, prepare, register, runtime, trusted } = setup();
    const getConnection = handlers.get(DESKTOP_CONNECTION_CHANNEL)!;
    const first = prepare(1);
    commit(first.url);
    expect(register(first.navigationToken)).toBe(true);

    const recovery = getConnection(trusted, {
      navigationToken: first.navigationToken,
      generation: 1,
    });
    prepare(2);

    await expect(recovery).rejects.toThrow("desktop document binding mismatch");
    expect(runtime.recover).toHaveBeenCalledWith(1);
  });

  it("advances only a registered same-port document and preserves its navigation token", async () => {
    const { commit, controller, handlers, prepare, register, runtime, trusted } = setup(
      "/synthetic/athlete",
      "service-managed",
    );
    const getConnection = handlers.get(DESKTOP_CONNECTION_CHANNEL)!;
    const prepared = prepare(1);

    expect(controller.advanceCurrentDocumentGeneration(2)).toBe(false);
    commit(prepared.url);
    expect(register(prepared.navigationToken)).toBe(true);
    await runtime.recover(1);
    expect(controller.advanceCurrentDocumentGeneration(2)).toBe(true);
    expect(() => controller.advanceCurrentDocumentGeneration(1)).toThrow(
      "invalid desktop daemon generation",
    );
    await expect(
      getConnection(trusted, { navigationToken: prepared.navigationToken }),
    ).resolves.toMatchObject({ generation: 2 });
  });

  it("qualifies load failures against only the latest prepared URL", () => {
    const { controller, prepare, window } = setup();
    const first = prepare(1);
    expect(controller.isCurrentDocumentNavigation(window as never, first.url)).toBe(true);
    const second = prepare(2);
    expect(controller.isCurrentDocumentNavigation(window as never, first.url)).toBe(false);
    expect(controller.isCurrentDocumentNavigation(window as never, second.url)).toBe(true);
    expect(
      controller.isCurrentDocumentNavigation(
        window as never,
        `${second.url}&navigationToken=${second.navigationToken}`,
      ),
    ).toBe(false);
  });

  it("refuses a stale current window without advancing its binding", () => {
    const { commit, controller, prepare, register, setCurrentWindow } = setup();
    const prepared = prepare(1);
    commit(prepared.url);
    expect(register(prepared.navigationToken)).toBe(true);
    setCurrentWindow({
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        mainFrame: { url: prepared.url },
      },
    });

    expect(controller.advanceCurrentDocumentGeneration(2)).toBe(false);
  });

  it("refuses coordinates for a different athlete home", async () => {
    const { commit, handlers, prepare, register, trusted } = setup("/synthetic/other-athlete");
    const getConnection = handlers.get(DESKTOP_CONNECTION_CHANNEL)!;
    const prepared = prepare(1);
    commit(prepared.url);
    expect(register(prepared.navigationToken)).toBe(true);

    await expect(
      getConnection(trusted, { navigationToken: prepared.navigationToken }),
    ).rejects.toThrow("desktop daemon home mismatch");
  });

  it("rejects malformed and extra connection and settlement fields", async () => {
    const { commit, handlers, prepare, register, runtime, trusted } = setup();
    const getConnection = handlers.get(DESKTOP_CONNECTION_CHANNEL)!;
    const settle = handlers.get(DESKTOP_INITIAL_SETUP_STATUS_SETTLED_CHANNEL)!;
    const prepared = prepare(1);
    commit(prepared.url);
    expect(register(prepared.navigationToken)).toBe(true);

    for (const request of [
      undefined,
      false,
      {},
      { navigationToken: prepared.navigationToken, generation: 0 },
      { navigationToken: prepared.navigationToken, generation: 1.5 },
      { navigationToken: prepared.navigationToken, generation: 1, extra: true },
    ]) {
      await expect(getConnection(trusted, request)).rejects.toThrow(
        "invalid desktop connection request",
      );
    }
    for (const request of [
      undefined,
      null,
      {},
      { navigationToken: prepared.navigationToken, generation: 0 },
      { navigationToken: prepared.navigationToken, generation: 1, extra: true },
    ]) {
      await expect(settle(trusted, request)).rejects.toThrow(
        "invalid initial setup status settlement",
      );
    }
    expect(runtime.recover).not.toHaveBeenCalled();
  });

  it("rejects untrusted registration and every request after disposal", async () => {
    const { commit, controller, handlers, listeners, prepare, register, trusted } = setup();
    const getConnection = handlers.get(DESKTOP_CONNECTION_CHANNEL)!;
    const prepared = prepare(1);
    commit(prepared.url);
    expect(
      register(prepared.navigationToken, {
        sender: {},
        senderFrame: { url: prepared.url },
      }),
    ).toBe(false);
    expect(register(prepared.navigationToken)).toBe(true);
    const retainedGetConnection = getConnection;
    controller.dispose();

    await expect(
      retainedGetConnection(trusted, { navigationToken: prepared.navigationToken }),
    ).rejects.toThrow("untrusted desktop connection request");
    expect(handlers.size).toBe(0);
    expect(listeners.size).toBe(0);
  });
});
