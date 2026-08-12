import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  DESKTOP_CRASH_TELEMETRY_FIELD_LIMIT,
  describeChildProcessGone,
  describeRenderProcessGone,
  installDesktopCrashTelemetry,
  startDesktopCrashReporter,
} from "../src/main/crash-telemetry.js";

type Listener = (...args: any[]) => void;

function appPort() {
  const listeners = new Map<string, Listener[]>();
  const on = vi.fn((name: string, listener: Listener) => {
    listeners.set(name, [...(listeners.get(name) ?? []), listener]);
    return undefined;
  });
  return {
    port: { on } as never,
    on,
    emit(name: string, ...args: unknown[]) {
      for (const listener of listeners.get(name) ?? []) listener(...args);
    },
    names: () => [...listeners.keys()],
  };
}

function webContents(url: string, title: string) {
  return { getURL: () => url, getTitle: () => title };
}

describe("desktop crash telemetry", () => {
  it("registers both crash listeners on the supplied app", () => {
    const app = appPort();

    installDesktopCrashTelemetry({ app: app.port, log: vi.fn() });

    expect(app.names().sort()).toEqual(["child-process-gone", "render-process-gone"]);
    expect(app.on).toHaveBeenCalledTimes(2);
  });

  it("logs the renderer crash reason, exit code, url, and title", () => {
    const app = appPort();
    const log = vi.fn();

    installDesktopCrashTelemetry({ app: app.port, log });
    app.emit(
      "render-process-gone",
      {},
      webContents("enduragent://app/index.html", "Enduragent"),
      { reason: "crashed", exitCode: 133 },
    );

    expect(log).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(
      "desktop-renderer-process-gone reason=crashed exitCode=133 url=enduragent://app/index.html title=Enduragent",
    );
  });

  it("logs the child process type, reason, exit code, and name", () => {
    const app = appPort();
    const log = vi.fn();

    installDesktopCrashTelemetry({ app: app.port, log });
    app.emit("child-process-gone", {}, {
      type: "Utility",
      reason: "oom",
      exitCode: 9,
      name: "enduragent desktop runtime",
    });

    expect(log).toHaveBeenCalledWith(
      "desktop-child-process-gone type=Utility reason=oom exitCode=9 name=enduragent_desktop_runtime",
    );
  });

  it("keeps the renderer crash line closed over query strings, fragments, and control characters", () => {
    const line = describeRenderProcessGone({
      url: "enduragent://app/index.html?token=secret-value#fragment",
      title: "Enduragent\nsecond line",
      reason: "abnormal-exit",
      exitCode: 0,
    });

    expect(line).toBe(
      "desktop-renderer-process-gone reason=abnormal-exit exitCode=0 url=enduragent://app/index.html title=Enduragent_second_line",
    );
    expect(line).not.toContain("secret");
    expect(line).not.toContain("fragment");
    expect(line.split("\n")).toHaveLength(1);
  });

  it("truncates oversized fields and marks missing ones", () => {
    const line = describeChildProcessGone({
      type: "Utility",
      reason: "x".repeat(DESKTOP_CRASH_TELEMETRY_FIELD_LIMIT + 40),
      exitCode: Number.NaN,
    });

    expect(line).toBe(
      `desktop-child-process-gone type=Utility reason=${"x".repeat(DESKTOP_CRASH_TELEMETRY_FIELD_LIMIT)}... exitCode=unknown name=unknown`,
    );
  });

  it("survives a webContents that refuses to describe itself", () => {
    const app = appPort();
    const log = vi.fn();

    installDesktopCrashTelemetry({ app: app.port, log });
    app.emit(
      "render-process-gone",
      {},
      {
        getURL() {
          throw new TypeError("destroyed");
        },
        getTitle() {
          throw new TypeError("destroyed");
        },
      },
      { reason: "killed", exitCode: 1 },
    );

    expect(log).toHaveBeenCalledWith(
      "desktop-renderer-process-gone reason=killed exitCode=1 url=unknown title=unknown",
    );
  });

  it("swallows a failing log sink instead of breaking the crash path", () => {
    const app = appPort();
    const log = vi.fn(() => {
      throw new TypeError("stderr closed");
    });

    installDesktopCrashTelemetry({ app: app.port, log });

    expect(() => {
      app.emit("child-process-gone", {}, { type: "GPU", reason: "crashed", exitCode: 5 });
    }).not.toThrow();
    expect(log).toHaveBeenCalledOnce();
  });

  it("collects local minidumps without uploading them anywhere", () => {
    const start = vi.fn();

    expect(startDesktopCrashReporter({ crashReporter: { start }, log: vi.fn() })).toBe("started");
    expect(start).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledWith({ uploadToServer: false });
  });

  it("reports an unavailable crash reporter without failing startup", () => {
    const log = vi.fn();
    const start = vi.fn(() => {
      throw new TypeError("crashpad unavailable");
    });

    expect(startDesktopCrashReporter({ crashReporter: { start }, log })).toBe("unavailable");
    expect(log).toHaveBeenCalledWith("desktop-crash-reporter-unavailable");
    expect(JSON.stringify(log.mock.calls)).not.toContain("crashpad unavailable");
  });

  it("starts the crash reporter and the listeners before any window in the production entry", async () => {
    const source = await readFile(new URL("../src/main/index.ts", import.meta.url), "utf8");
    const userData = source.indexOf("bindWindowsUserData(app);");
    const reporter = source.indexOf("startDesktopCrashReporter({ crashReporter });");
    const telemetry = source.indexOf("installDesktopCrashTelemetry({ app });");

    expect(userData).toBeGreaterThanOrEqual(0);
    expect(reporter).toBeGreaterThan(userData);
    expect(telemetry).toBeGreaterThan(reporter);
    expect(telemetry).toBeLessThan(source.indexOf("registerDesktopScheme();"));
    expect(telemetry).toBeLessThan(source.indexOf("app.requestSingleInstanceLock();"));
    expect(telemetry).toBeLessThan(source.indexOf("await app.whenReady();"));
    expect(telemetry).toBeLessThan(source.indexOf("new BrowserWindow("));
  });
});
