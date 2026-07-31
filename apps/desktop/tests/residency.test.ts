import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class Emitter {
    private readonly listeners = new Map<string, Set<(...args: any[]) => void>>();
    on(name: string, listener: (...args: any[]) => void) {
      const listeners = this.listeners.get(name) ?? new Set();
      listeners.add(listener);
      this.listeners.set(name, listeners);
      return this;
    }
    emit(name: string, ...args: any[]) {
      for (const listener of this.listeners.get(name) ?? []) listener(...args);
    }
    removeAllListeners() {
      this.listeners.clear();
      return this;
    }
    listenerCount(name: string) {
      return this.listeners.get(name)?.size ?? 0;
    }
  }
  const order: string[] = [];
  const image = {
    isEmpty: vi.fn(() => false),
    setTemplateImage: vi.fn(() => order.push("template")),
  };
  class FakeTray extends Emitter {
    static instances: FakeTray[] = [];
    readonly setToolTip = vi.fn();
    readonly popUpContextMenu = vi.fn();
    readonly getBounds = vi.fn(() => ({ x: 10, y: 10, width: 16, height: 16 }));
    readonly destroy = vi.fn(() => order.push("tray-destroy"));
    constructor(readonly constructorImage: unknown) {
      super();
      order.push("tray-create");
      FakeTray.instances.push(this);
    }
  }
  const popoverWindow = new Emitter();
  const popover = {
    window: popoverWindow,
    toggle: vi.fn(),
    hide: vi.fn(),
    close: vi.fn(() => order.push("popover-destroy")),
  };
  const app = Object.assign(new Emitter(), {
    requestSingleInstanceLock: vi.fn(() => true),
    exit: vi.fn(),
    whenReady: vi.fn(async () => {}),
    quit: vi.fn(),
    getLoginItemSettings: vi.fn(),
    setLoginItemSettings: vi.fn(),
    getVersion: vi.fn(() => "0.0.1"),
    getPath: vi.fn(() => "/synthetic/user-data"),
    getAppPath: vi.fn(() => "/synthetic/app"),
  });
  return {
    order,
    image,
    FakeTray,
    popover,
    popoverWindow,
    createTrayPopover: vi.fn(() => popover),
    buildFromTemplate: vi.fn((template) => ({ template })),
    app,
    BrowserWindow: vi.fn(),
    supervisor: vi.fn(),
    registerDesktopScheme: vi.fn(),
  };
});

vi.mock("electron", () => ({
  app: mocks.app,
  BrowserWindow: mocks.BrowserWindow,
  Menu: { buildFromTemplate: mocks.buildFromTemplate },
  Tray: mocks.FakeTray,
  nativeImage: { createFromPath: vi.fn(() => mocks.image) },
  dialog: {},
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn(), removeListener: vi.fn() },
  safeStorage: {},
  session: { defaultSession: { protocol: { unhandle: vi.fn() } } },
  utilityProcess: { fork: vi.fn() },
}));

vi.mock("../src/main/tray-popover.js", () => ({
  createTrayPopover: mocks.createTrayPopover,
}));

vi.mock("../src/main/security.js", () => ({
  registerDesktopScheme: mocks.registerDesktopScheme,
  desktopWindowOptions: vi.fn(),
  hardenDesktopWindow: vi.fn(),
  installDesktopProtocol: vi.fn(),
  isTrustedConnectionRequest: vi.fn(),
  rendererOutputRoot: vi.fn(),
}));

vi.mock("../src/main/supervisor.js", () => ({
  DesktopDaemonSupervisor: mocks.supervisor,
  isUtilityTerminalFrame: vi.fn(),
}));

vi.mock("../src/main/credential-vault.js", () => ({
  CREDENTIAL_DIRECTORY_NAME: "credentials",
  createCredentialVault: vi.fn(),
}));

vi.mock("../src/main/onboarding-ipc.js", () => ({
  registerOnboardingIpc: vi.fn(),
  runtimeConfigurationForCredential: vi.fn(),
}));

vi.mock("@enduragent/coach-client", () => ({ connectCoachClient: vi.fn() }));

import { createDesktopResidency } from "../src/main/residency.js";

function loginState(
  status: "not-found" | "not-registered" | "enabled" | "requires-approval" = "not-found",
  openAtLogin = false,
) {
  return { openAtLogin, executableWillLaunchAtLogin: openAtLogin, status };
}

function setup() {
  const events: unknown[] = [];
  const reportFailure = vi.fn();
  const mainWindow = {
    current: vi.fn(() => null),
    show: vi.fn(async () => ({ id: 1 })),
  };
  mocks.app.getLoginItemSettings.mockReturnValue(loginState() as never);
  const residency = createDesktopResidency({
    app: mocks.app as never,
    mainWindow: mainWindow as never,
    trayIconPath: "/synthetic/trayTemplate.png",
    trayPopoverUrl: "enduragent://app/tray.html",
    reportFailure,
    observe: (event) => events.push(event),
  });
  return { residency, events, reportFailure, mainWindow };
}

beforeEach(() => {
  mocks.order.length = 0;
  mocks.FakeTray.instances.length = 0;
  mocks.image.isEmpty.mockReturnValue(false);
  mocks.image.isEmpty.mockClear();
  mocks.image.setTemplateImage.mockClear();
  mocks.popover.toggle.mockClear();
  mocks.popover.hide.mockClear();
  mocks.popover.close.mockClear();
  mocks.createTrayPopover.mockClear();
  mocks.buildFromTemplate.mockClear();
  mocks.app.quit.mockClear();
  mocks.app.getLoginItemSettings.mockReset();
  mocks.app.setLoginItemSettings.mockReset();
});

describe("desktop residency", () => {
  it("deduplicates start, template-marks before one tray, and toggles one lazy popover", async () => {
    const { residency, events } = setup();
    const first = residency.start();
    const second = residency.start();
    expect(first).toBe(second);
    await Promise.all([first, second]);
    expect(mocks.order.slice(0, 2)).toEqual(["template", "tray-create"]);
    expect(mocks.image.isEmpty).toHaveBeenCalledOnce();
    expect(mocks.FakeTray.instances).toHaveLength(1);
    const tray = mocks.FakeTray.instances[0]!;
    expect(tray.setToolTip).toHaveBeenCalledWith("Enduragent");
    expect(tray.listenerCount("click")).toBe(1);
    expect(tray.listenerCount("right-click")).toBe(1);
    tray.emit("click");
    tray.emit("click");
    expect(mocks.createTrayPopover).toHaveBeenCalledOnce();
    expect(mocks.popover.toggle).toHaveBeenCalledTimes(2);
    expect(mocks.app.getLoginItemSettings).not.toHaveBeenCalled();
    expect(events).toContainEqual({ type: "tray-created" });
  });

  it("builds a fresh exact native menu and uses current checkbox truth", async () => {
    const { residency, mainWindow, events } = setup();
    await residency.start();
    const tray = mocks.FakeTray.instances[0]!;
    mocks.app.getLoginItemSettings
      .mockReturnValueOnce(loginState("enabled", true) as never)
      .mockReturnValueOnce(loginState("not-registered", false) as never);
    tray.emit("right-click");
    tray.emit("right-click");
    expect(mocks.app.getLoginItemSettings).toHaveBeenCalledTimes(2);
    expect(mocks.buildFromTemplate).toHaveBeenCalledTimes(2);
    const first = mocks.buildFromTemplate.mock.calls[0]![0] as Array<Record<string, unknown>>;
    expect(first.map((item) => item.label ?? item.type)).toEqual([
      "Open Enduragent",
      "separator",
      "Open at Login",
      "separator",
      "Quit Enduragent",
    ]);
    expect(first[2]).toMatchObject({ type: "checkbox", checked: true, enabled: true });
    (first[0]!.click as () => void)();
    await vi.waitFor(() => expect(mainWindow.show).toHaveBeenCalledOnce());
    (first[2]!.click as (item: { checked: boolean }) => void)({ checked: false });
    expect(mocks.app.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: false });
    expect(events).toContainEqual({ type: "main-window-shown" });
  });

  it("keeps Open and Quit usable when reads fail and emits fixed failure tags only", async () => {
    const secret = new Error("private setting path");
    secret.stack = "private stack";
    const { residency, reportFailure, mainWindow } = setup();
    await residency.start();
    mocks.app.getLoginItemSettings.mockImplementation(() => {
      throw secret;
    });
    mocks.FakeTray.instances[0]!.emit("right-click");
    const menu = mocks.buildFromTemplate.mock.calls[0]![0] as Array<Record<string, unknown>>;
    expect(menu[0]!.click).toBeTypeOf("function");
    expect(menu[2]).toMatchObject({ checked: false, enabled: false });
    expect(menu[4]!.click).toBeTypeOf("function");
    expect(reportFailure).toHaveBeenCalledWith("read-login-item");
    expect(JSON.stringify(reportFailure.mock.calls)).not.toContain(secret.message);
    (menu[0]!.click as () => void)();
    await vi.waitFor(() => expect(mainWindow.show).toHaveBeenCalledOnce());
    (menu[4]!.click as () => void)();
    expect(mocks.app.quit).toHaveBeenCalledOnce();
  });

  it("re-reads after setter failure and reports no caught value", async () => {
    const { residency, reportFailure, events } = setup();
    await residency.start();
    mocks.app.getLoginItemSettings
      .mockReturnValueOnce(loginState() as never)
      .mockReturnValueOnce(loginState("not-registered") as never);
    mocks.app.setLoginItemSettings.mockImplementation(() => {
      throw new Error("private setter path");
    });
    mocks.FakeTray.instances[0]!.emit("right-click");
    const menu = mocks.buildFromTemplate.mock.calls[0]![0] as Array<Record<string, unknown>>;
    (menu[2]!.click as (item: { checked: boolean }) => void)({ checked: true });
    expect(reportFailure).toHaveBeenCalledWith("set-login-item");
    expect(mocks.app.getLoginItemSettings).toHaveBeenCalledTimes(2);
    expect(events).toContainEqual({ type: "login-item-read", state: loginState("not-registered") });
  });

  it("deduplicates quit and destroys popover before tray exactly once", async () => {
    const { residency } = setup();
    await residency.start();
    mocks.FakeTray.instances[0]!.emit("click");
    residency.quit();
    residency.quit();
    expect(mocks.app.quit).toHaveBeenCalledOnce();
    residency.close();
    residency.close();
    expect(mocks.popover.close).toHaveBeenCalledOnce();
    expect(mocks.FakeTray.instances[0]!.destroy).toHaveBeenCalledOnce();
    expect(mocks.order.slice(-2)).toEqual(["popover-destroy", "tray-destroy"]);
    expect(mocks.app.setLoginItemSettings).not.toHaveBeenCalled();
  });

  it("reports show failures by operation and keeps observer data closed", async () => {
    const { residency, reportFailure, mainWindow, events } = setup();
    mainWindow.show.mockRejectedValue(new Error("secret token and path"));
    await residency.showMainWindow();
    expect(reportFailure).toHaveBeenCalledWith("show-window");
    expect(JSON.stringify(reportFailure.mock.calls)).not.toContain("secret");
    expect(events).toEqual([]);
  });

  it("presents the initial window only after its renderer URL loads", async () => {
    const source = await readFile(resolve(import.meta.dirname, "../src/main/index.ts"), "utf8");
    const creationStart = source.indexOf("windowCreation = (async () => {");
    const load = source.indexOf("await created.loadURL(DESKTOP_RENDERER_URL);", creationStart);
    const restore = source.indexOf("if (created.isMinimized()) created.restore();", load);
    const show = source.indexOf("created.show();", load);
    const focus = source.indexOf("created.focus();", load);
    const creationEnd = source.indexOf("})().finally(() => {", focus);
    const initialShow = source.indexOf("const initialWindow = await mainWindow.show();");
    const residencyStart = source.indexOf("await residency.start();", initialShow);

    expect(source).not.toContain('created.once("ready-to-show"');
    expect(creationStart).toBeGreaterThanOrEqual(0);
    expect(load).toBeGreaterThan(creationStart);
    expect(restore).toBeGreaterThan(load);
    expect(show).toBeGreaterThan(restore);
    expect(focus).toBeGreaterThan(show);
    expect(creationEnd).toBeGreaterThan(focus);
    expect(source.slice(load, creationEnd)).not.toMatch(/\bcatch\b/);
    expect(initialShow).toBeGreaterThan(creationEnd);
    expect(residencyStart).toBeGreaterThan(initialShow);
  });

  it("reports tray-start and keeps running when the tray icon cannot load", async () => {
    const { residency, reportFailure, events } = setup();
    mocks.image.isEmpty.mockReturnValue(true);
    await expect(residency.start()).resolves.toBeUndefined();
    expect(mocks.FakeTray.instances).toHaveLength(0);
    expect(reportFailure).toHaveBeenCalledWith("tray-start");
    expect(events).toEqual([]);
    residency.close();
    residency.quit();
    expect(mocks.app.quit).toHaveBeenCalledOnce();
  });

  it("anchors the tray icon to the build output instead of the launch-dependent app path", async () => {
    const source = await readFile(resolve(import.meta.dirname, "../src/main/index.ts"), "utf8");
    expect(source).toContain(
      'trayIconPath: resolve(mainDirectory, "../../resources/trayTemplate.png")',
    );
    expect(source).not.toContain('join(app.getAppPath(), "resources"');
  });

  it("keeps the production failure adapter closed and gates the loser before bootstrap", async () => {
    const source = await readFile(resolve(import.meta.dirname, "../src/main/index.ts"), "utf8");
    expect(source).toContain("desktop-residency-failure ${operation}\\n");
    expect(source).toContain("const primaryInstance = app.requestSingleInstanceLock();");
    expect(source).toContain("if (!primaryInstance) {\n  app.exit(0);");
    mocks.app.requestSingleInstanceLock.mockReturnValueOnce(false);
    await import("../src/main/index.js");
    expect(mocks.app.exit).toHaveBeenCalledWith(0);
    expect(mocks.app.whenReady).not.toHaveBeenCalled();
    expect(mocks.BrowserWindow).not.toHaveBeenCalled();
    expect(mocks.FakeTray.instances).toHaveLength(0);
    expect(mocks.app.getLoginItemSettings).not.toHaveBeenCalled();
    expect(mocks.app.setLoginItemSettings).not.toHaveBeenCalled();
    expect(mocks.supervisor).not.toHaveBeenCalled();
  });
});
