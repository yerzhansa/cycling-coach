import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class Emitter {
    private readonly listeners = new Map<string, Set<(...args: any[]) => void>>();
    on(name: string, listener: (...args: any[]) => void) {
      const listeners = this.listeners.get(name) ?? new Set();
      listeners.add(listener);
      this.listeners.set(name, listeners);
      return this;
    }
  }
  const startupError = new TypeError("synthetic startup rejection");
  startupError.stack = "TypeError: synthetic startup rejection\n    at synthetic-startup.ts:1:1";
  const app = Object.assign(new Emitter(), {
    commandLine: { getSwitchValue: vi.fn(() => ""), appendSwitch: vi.fn() },
    dock: { hide: vi.fn() },
    exit: vi.fn(),
    requestSingleInstanceLock: vi.fn(() => true),
    setAppUserModelId: vi.fn(),
    setPath: vi.fn(),
    whenReady: vi.fn(() => Promise.reject(startupError)),
  });
  return {
    app,
    startupError,
    dialog: { showErrorBox: vi.fn() },
    crashReporter: { start: vi.fn() },
  };
});

vi.mock("electron", () => ({
  app: mocks.app,
  BrowserWindow: vi.fn(),
  clipboard: {},
  crashReporter: mocks.crashReporter,
  dialog: mocks.dialog,
  ipcMain: {},
  Menu: {},
  nativeImage: {},
  net: {},
  powerMonitor: {},
  protocol: {},
  safeStorage: {},
  screen: {},
  session: {},
  shell: {},
  Tray: vi.fn(),
  utilityProcess: {},
}));

vi.mock("../src/main/security.js", () => ({
  createDesktopRendererConsoleCapture: vi.fn(() => ({
    attach: vi.fn(),
    hasMessageContaining: vi.fn(() => false),
  })),
  desktopWindowOptions: vi.fn(),
  hardenDesktopWindow: vi.fn(),
  installDesktopProtocol: vi.fn(),
  isTrustedConnectionRequest: vi.fn(),
  registerDesktopScheme: vi.fn(),
  rendererOutputRoot: vi.fn(),
  resolveDesktopRendererSource: vi.fn(),
}));

const scratchDirectories: string[] = [];
const originalAthleteHome = process.env.ENDURAGENT_HOME;
const originalAcceptanceHidden = process.env.ENDURAGENT_ACCEPTANCE_HIDDEN;

afterEach(async () => {
  if (originalAthleteHome === undefined) delete process.env.ENDURAGENT_HOME;
  else process.env.ENDURAGENT_HOME = originalAthleteHome;
  if (originalAcceptanceHidden === undefined) delete process.env.ENDURAGENT_ACCEPTANCE_HIDDEN;
  else process.env.ENDURAGENT_ACCEPTANCE_HIDDEN = originalAcceptanceHidden;
  vi.restoreAllMocks();
  vi.resetModules();
  await Promise.all(
    scratchDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("desktop startup catch", () => {
  it("logs a classified failure even when the dialog is gated off", async () => {
    const root = await mkdtemp(join(tmpdir(), "enduragent-desktop-startup-catch-"));
    scratchDirectories.push(root);
    process.env.ENDURAGENT_HOME = root;
    process.env.ENDURAGENT_ACCEPTANCE_HIDDEN = "1";
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await import("../src/main/index.js");

    await vi.waitFor(() => expect(mocks.app.exit).toHaveBeenCalledWith(1), { timeout: 20_000 });
    expect(mocks.dialog.showErrorBox).not.toHaveBeenCalled();
    const record = JSON.parse(
      (await readFile(join(root, "logs", "log.jsonl"), "utf8")).trim(),
    ) as Record<string, unknown>;
    expect(record).toMatchObject({
      level: "error",
      component: "desktop",
      event: "startup_failed",
      err: {
        name: "TypeError",
        message: mocks.startupError.message,
        stack: mocks.startupError.stack,
      },
    });
  }, 30_000);
});
