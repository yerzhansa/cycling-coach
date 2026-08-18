import { randomBytes } from "node:crypto";
import type { BrowserWindow, IpcMain, IpcMainEvent, IpcMainInvokeEvent } from "electron";
import {
  DESKTOP_CONNECTION_CHANNEL,
  DESKTOP_DOCUMENT_REGISTRATION_CHANNEL,
  DESKTOP_INITIAL_SETUP_STATUS_SETTLED_CHANNEL,
} from "./constants.js";
import type { DesktopDaemonLifecycle } from "./daemon-lifecycle.js";
import { requireDesktopDaemonHome } from "./daemon-home-binding.js";
import {
  createDesktopRendererUrl,
  desktopRendererNavigationToken,
} from "./renderer-navigation.js";
import { isTrustedConnectionRequest } from "./security.js";

function rendererConnection(
  connection: ReturnType<DesktopDaemonLifecycle["connection"]>,
  expectedAthleteHome: string,
): {
  readonly url: `ws://127.0.0.1:${number}/rpc`;
  readonly rendererCapability: string;
  readonly generation: number;
} {
  requireDesktopDaemonHome(expectedAthleteHome, connection.athleteHome);
  return {
    url: connection.url,
    rendererCapability: connection.rendererCapability,
    generation: connection.generation,
  };
}

interface DesktopDocumentBinding {
  readonly window: BrowserWindow;
  readonly navigationToken: string;
  generation: number;
  registered: boolean;
}

export interface DesktopConnectionIpcController {
  prepareDocumentNavigation(window: BrowserWindow, generation: number): string;
  advanceCurrentDocumentGeneration(generation: number): boolean;
  isCurrentDocumentNavigation(window: BrowserWindow, url: string): boolean;
  dispose(): void;
}

function validGeneration(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function installDesktopConnectionIpc(input: {
  readonly ipcMain: Pick<IpcMain, "handle" | "on" | "removeHandler" | "removeListener">;
  readonly currentWindow: () => BrowserWindow | undefined;
  readonly expectedAthleteHome: string;
  readonly runtime: Pick<DesktopDaemonLifecycle, "connection" | "recover">;
  readonly initialSetupStatusSettled: (generation: number) => Promise<void>;
}): DesktopConnectionIpcController {
  let binding: DesktopDocumentBinding | undefined;
  let disposed = false;

  const requireTrusted = (
    event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">,
  ): BrowserWindow => {
    const currentWindow = input.currentWindow();
    if (
      disposed ||
      currentWindow === undefined ||
      !isTrustedConnectionRequest(event, currentWindow)
    ) {
      throw new Error("untrusted desktop connection request");
    }
    return currentWindow;
  };

  const requireBinding = (
    event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">,
    navigationToken: string,
    expected?: DesktopDocumentBinding,
  ): DesktopDocumentBinding => {
    const currentWindow = requireTrusted(event);
    const eventUrl = event.senderFrame?.url;
    const current = binding;
    if (
      eventUrl === undefined ||
      desktopRendererNavigationToken(eventUrl) !== navigationToken ||
      current === undefined ||
      !current.registered ||
      current.window !== currentWindow ||
      current.navigationToken !== navigationToken ||
      (expected !== undefined && current !== expected)
    ) {
      throw new Error("desktop document binding mismatch");
    }
    return current;
  };

  const requireGeneration = (current: DesktopDocumentBinding, generation: number): void => {
    if (current.generation !== generation) {
      throw new Error("desktop document daemon generation mismatch");
    }
  };

  const registerDocument = (event: IpcMainEvent, request?: unknown): void => {
    const refuse = (): void => {
      event.returnValue = false;
    };
    if (!exactObject(request, ["navigationToken"])) {
      refuse();
      return;
    }
    const navigationToken = request.navigationToken;
    if (typeof navigationToken !== "string") {
      refuse();
      return;
    }
    let currentWindow: BrowserWindow;
    try {
      currentWindow = requireTrusted(event);
    } catch {
      refuse();
      return;
    }
    const current = binding;
    const eventUrl = event.senderFrame?.url;
    if (
      eventUrl === undefined ||
      desktopRendererNavigationToken(eventUrl) !== navigationToken ||
      current === undefined ||
      current.window !== currentWindow ||
      current.navigationToken !== navigationToken
    ) {
      refuse();
      return;
    }
    current.registered = true;
    event.returnValue = true;
  };

  input.ipcMain.on(DESKTOP_DOCUMENT_REGISTRATION_CHANNEL, registerDocument);
  input.ipcMain.handle(DESKTOP_CONNECTION_CHANNEL, async (event, request?: unknown) => {
    const recoveryRequested = exactObject(request, ["generation", "navigationToken"]);
    if (!recoveryRequested && !exactObject(request, ["navigationToken"])) {
      requireTrusted(event);
      throw new TypeError("invalid desktop connection request");
    }
    const navigationToken = request.navigationToken;
    if (typeof navigationToken !== "string") {
      requireTrusted(event);
      throw new TypeError("invalid desktop connection request");
    }
    const current = requireBinding(event, navigationToken);
    let connection: ReturnType<DesktopDaemonLifecycle["connection"]>;
    if (recoveryRequested) {
      const generation = request.generation;
      if (!validGeneration(generation)) {
        throw new TypeError("invalid desktop connection request");
      }
      requireGeneration(current, generation);
      connection = await input.runtime.recover(generation);
    } else {
      connection = input.runtime.connection();
    }
    const projected = rendererConnection(connection, input.expectedAthleteHome);
    const settled = requireBinding(event, navigationToken, current);
    requireGeneration(settled, connection.generation);
    return projected;
  });

  input.ipcMain.handle(
    DESKTOP_INITIAL_SETUP_STATUS_SETTLED_CHANNEL,
    async (event, request?: unknown) => {
      if (!exactObject(request, ["generation", "navigationToken"])) {
        requireTrusted(event);
        throw new TypeError("invalid initial setup status settlement");
      }
      const navigationToken = request.navigationToken;
      const generation = request.generation;
      if (typeof navigationToken !== "string" || !validGeneration(generation)) {
        requireTrusted(event);
        throw new TypeError("invalid initial setup status settlement");
      }
      const current = requireBinding(event, navigationToken);
      requireGeneration(current, generation);
      await input.initialSetupStatusSettled(generation);
      const settled = requireBinding(event, navigationToken, current);
      requireGeneration(settled, generation);
    },
  );

  return {
    prepareDocumentNavigation(window, generation) {
      if (disposed || !validGeneration(generation)) {
        throw new TypeError("invalid desktop daemon generation");
      }
      const currentWindow = input.currentWindow();
      if (
        currentWindow === undefined ||
        currentWindow !== window ||
        currentWindow.isDestroyed() ||
        currentWindow.webContents.isDestroyed()
      ) {
        throw new TypeError("invalid desktop renderer window");
      }
      const navigationToken = randomBytes(32).toString("base64url");
      binding = { window, navigationToken, generation, registered: false };
      return createDesktopRendererUrl(navigationToken);
    },
    advanceCurrentDocumentGeneration(generation) {
      if (disposed || !validGeneration(generation)) {
        throw new TypeError("invalid desktop daemon generation");
      }
      const current = binding;
      const currentWindow = input.currentWindow();
      if (
        current === undefined ||
        !current.registered ||
        currentWindow === undefined ||
        current.window !== currentWindow
      ) {
        return false;
      }
      if (generation < current.generation) {
        throw new TypeError("invalid desktop daemon generation");
      }
      current.generation = generation;
      return true;
    },
    isCurrentDocumentNavigation(window, url) {
      const current = binding;
      return (
        !disposed &&
        current !== undefined &&
        current.window === window &&
        input.currentWindow() === window &&
        createDesktopRendererUrl(current.navigationToken) === url
      );
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      binding = undefined;
      input.ipcMain.removeListener(DESKTOP_DOCUMENT_REGISTRATION_CHANNEL, registerDocument);
      input.ipcMain.removeHandler(DESKTOP_CONNECTION_CHANNEL);
      input.ipcMain.removeHandler(DESKTOP_INITIAL_SETUP_STATUS_SETTLED_CHANNEL);
    },
  };
}
