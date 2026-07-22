import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  BrowserWindow: class {},
  net: { fetch: vi.fn() },
  protocol: { registerSchemesAsPrivileged: vi.fn() },
}));

import { net } from "electron";

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
  resolveDesktopRendererSource,
} from "../src/main/security.js";

describe("desktop security boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ["absent", undefined],
    ["valid", "https://attacker.invalid/renderer"],
    ["malformed", ":///synthetic-malformed-renderer"],
  ])("uses bundled renderers when packaged and the override is %s", (_case, override) => {
    expect(resolveDesktopRendererSource(true, override)).toEqual({
      kind: "bundled",
      trayPopoverUrl: "enduragent://app/tray.html",
    });
  });

  it("uses bundled renderers during development without an override", () => {
    expect(resolveDesktopRendererSource(false, undefined)).toEqual({
      kind: "bundled",
      trayPopoverUrl: "enduragent://app/tray.html",
    });
  });

  it("uses the development proxy and tray path when an override is present", () => {
    expect(
      resolveDesktopRendererSource(
        false,
        "http://127.0.0.1:5173/renderer/index.html?source=synthetic",
      ),
    ).toEqual({
      kind: "development",
      developmentUrl: "http://127.0.0.1:5173/renderer/index.html?source=synthetic",
      trayPopoverUrl: "http://127.0.0.1:5173/tray.html",
    });
  });

  it("proxies development renderer requests through the resolved source", async () => {
    let handler: ((request: Request) => Promise<Response>) | undefined;
    const protocol = {
      handle: vi.fn(async (_scheme: string, installed: (request: Request) => Promise<Response>) => {
        handler = installed;
      }),
    };
    vi.mocked(net.fetch).mockResolvedValueOnce(new Response("synthetic-proxied-renderer"));
    await installDesktopProtocol({
      session: { protocol } as never,
      currentDaemonPort: () => 45_001,
      rendererRoot: "/synthetic/renderer",
      rendererSource: resolveDesktopRendererSource(false, "http://127.0.0.1:5173/root"),
    });

    const response = await handler!(
      new Request("enduragent://app/assets/renderer.js?cache=synthetic"),
    );

    expect(net.fetch).toHaveBeenCalledOnce();
    expect(net.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:5173/assets/renderer.js?cache=synthetic",
    );
    expect(await response.text()).toBe("synthetic-proxied-renderer");
  });

  it("serves packaged renderer requests without fetching the override", async () => {
    let handler: ((request: Request) => Promise<Response>) | undefined;
    const protocol = {
      handle: vi.fn(async (_scheme: string, installed: (request: Request) => Promise<Response>) => {
        handler = installed;
      }),
    };
    const rendererSource = resolveDesktopRendererSource(true, "https://attacker.invalid/renderer");
    await installDesktopProtocol({
      session: { protocol } as never,
      currentDaemonPort: () => 45_001,
      rendererRoot: "/synthetic/renderer",
      rendererSource,
    });

    const response = await handler!(new Request("enduragent://app/missing.html"));

    expect(rendererSource).not.toHaveProperty("developmentUrl");
    expect(net.fetch).not.toHaveBeenCalled();
    expect(response.status).toBe(404);
  });

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
      rendererSource: resolveDesktopRendererSource(false, undefined),
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
