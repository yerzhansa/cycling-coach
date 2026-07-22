import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  BrowserWindow: class {},
  net: { fetch: vi.fn() },
  protocol: { registerSchemesAsPrivileged: vi.fn() },
}));

import {
  DESKTOP_CONNECTION_CHANNEL,
  DESKTOP_HOST,
  DESKTOP_RENDERER_ORIGIN,
  DESKTOP_RENDERER_URL,
  DESKTOP_SCHEME,
  DESKTOP_WINDOW_HEIGHT,
  DESKTOP_WINDOW_MIN_HEIGHT,
  DESKTOP_WINDOW_MIN_WIDTH,
  DESKTOP_WINDOW_WIDTH,
  createDesktopContentSecurityPolicy,
} from "../src/main/constants.js";
import {
  desktopWindowOptions,
  installDesktopProtocol,
  isTrustedConnectionRequest,
} from "../src/main/security.js";

describe("desktop security boundary", () => {
  it("pins the scheme, IPC, window, and assigned-port-only CSP constants", () => {
    expect({
      DESKTOP_SCHEME,
      DESKTOP_HOST,
      DESKTOP_RENDERER_ORIGIN,
      DESKTOP_RENDERER_URL,
      DESKTOP_CONNECTION_CHANNEL,
    }).toEqual({
      DESKTOP_SCHEME: "enduragent",
      DESKTOP_HOST: "app",
      DESKTOP_RENDERER_ORIGIN: "enduragent://app",
      DESKTOP_RENDERER_URL: "enduragent://app/index.html",
      DESKTOP_CONNECTION_CHANNEL: "desktop:get-daemon-connection",
    });
    expect({
      DESKTOP_WINDOW_WIDTH,
      DESKTOP_WINDOW_HEIGHT,
      DESKTOP_WINDOW_MIN_WIDTH,
      DESKTOP_WINDOW_MIN_HEIGHT,
    }).toEqual({
      DESKTOP_WINDOW_WIDTH: 1180,
      DESKTOP_WINDOW_HEIGHT: 820,
      DESKTOP_WINDOW_MIN_WIDTH: 760,
      DESKTOP_WINDOW_MIN_HEIGHT: 600,
    });
    expect(createDesktopContentSecurityPolicy(45_001)).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src ws://127.0.0.1:45001; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'",
    );
  });

  it("uses the exact hardened BrowserWindow preferences", () => {
    expect(desktopWindowOptions("/synthetic/out/preload/index.cjs")).toEqual({
      width: 1180,
      height: 820,
      minWidth: 760,
      minHeight: 600,
      show: false,
      backgroundColor: "#f4f6f5",
      webPreferences: {
        preload: "/synthetic/out/preload/index.cjs",
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
      },
    });
  });

  it("emits an exact CSP pin from the current daemon port on every document load", async () => {
    let handler: ((request: Request) => Promise<Response>) | undefined;
    const protocol = {
      handle: vi.fn(async (_scheme: string, installed: (request: Request) => Promise<Response>) => {
        handler = installed;
      }),
    };
    let port = 45_001;
    await installDesktopProtocol({
      session: { protocol } as never,
      currentDaemonPort: () => port,
      rendererRoot: "/synthetic/renderer",
    });
    const first = await handler!(new Request("enduragent://app/missing.html"));
    port = 45_002;
    const second = await handler!(new Request("enduragent://app/missing.html"));
    const firstPolicy = first.headers.get("Content-Security-Policy");
    const secondPolicy = second.headers.get("Content-Security-Policy");
    expect(firstPolicy).toContain("connect-src ws://127.0.0.1:45001;");
    expect(secondPolicy).toContain("connect-src ws://127.0.0.1:45002;");
    expect(secondPolicy).not.toContain("ws://127.0.0.1:*");
  });

  it("requires the live window, sender, main frame, and exact URL", () => {
    const mainFrame: { url: string } = { url: DESKTOP_RENDERER_URL };
    const webContents = { isDestroyed: () => false, mainFrame };
    const window = { isDestroyed: () => false, webContents };
    expect(
      isTrustedConnectionRequest(
        { sender: webContents, senderFrame: mainFrame } as never,
        window as never,
      ),
    ).toBe(true);
    expect(
      isTrustedConnectionRequest(
        { sender: webContents, senderFrame: { url: DESKTOP_RENDERER_URL } } as never,
        window as never,
      ),
    ).toBe(false);
    mainFrame.url = "https://example.invalid";
    expect(
      isTrustedConnectionRequest(
        { sender: webContents, senderFrame: mainFrame } as never,
        window as never,
      ),
    ).toBe(false);
  });
});
