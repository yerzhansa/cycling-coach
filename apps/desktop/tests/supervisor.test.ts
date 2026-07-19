import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ utilityProcess: { fork: vi.fn() } }));

import type { DesktopDaemonResolution } from "@enduragent/coach/enduragent";
import { DesktopDaemonSupervisor, forkAppSupervisedDaemon } from "../src/main/supervisor.js";

class FakeUtilityProcess extends EventEmitter {
  readonly pid = 91;
  readonly postMessage = vi.fn();
  readonly kill = vi.fn(() => {
    this.emit("exit", 1);
    return true;
  });
}

afterEach(() => vi.useRealTimers());

describe("desktop main supervisor", () => {
  it("deduplicates concurrent resolution and clears only after owned close", async () => {
    const close = vi.fn(async () => {});
    const connected: DesktopDaemonResolution = {
      status: "connected",
      url: "ws://127.0.0.1:45001/rpc",
      token: "s".repeat(43),
      owner: "app-supervised",
      supervision: "app-supervised",
      close,
    };
    const resolveDaemon = vi.fn(async () => connected);
    const supervisor = new DesktopDaemonSupervisor(
      {
        env: {},
        executablePath: "/Applications/Enduragent",
        appVersion: "0.1.0",
        signal: new AbortController().signal,
      },
      "/synthetic/daemon-utility.js",
      resolveDaemon,
    );
    const first = supervisor.resolve();
    const second = supervisor.resolve();
    expect(first).toBe(second);
    const resolution = await first;
    expect(resolveDaemon).toHaveBeenCalledTimes(1);
    if (resolution.status === "connected")
      await Promise.all([resolution.close(), resolution.close()]);
    expect(close).toHaveBeenCalledTimes(1);
    await supervisor.resolve();
    expect(resolveDaemon).toHaveBeenCalledTimes(2);
  });

  it("starts over the closed control protocol and acknowledges terminal frames", async () => {
    const child = new FakeUtilityProcess();
    const fork = vi.mocked((await import("electron")).utilityProcess.fork);
    fork.mockReturnValue(child as never);
    const started = forkAppSupervisedDaemon({
      utilityEntry: "/synthetic/daemon-utility.js",
      homeRoot: "/synthetic/athlete",
      handoffCapability: "h".repeat(43),
    });
    child.emit("spawn");
    const handle = await started;
    expect(handle.pid).toBe(91);
    expect(fork).toHaveBeenCalledWith(
      "/synthetic/daemon-utility.js",
      [],
      expect.objectContaining({
        serviceName: "enduragent serve",
        stdio: "ignore",
      }),
    );
    expect(child.postMessage).toHaveBeenCalledWith({
      type: "start",
      homeRoot: "/synthetic/athlete",
      handoffCapability: "h".repeat(43),
    });
    child.emit("message", { type: "terminal", exitCode: 0 });
    expect(child.postMessage).toHaveBeenCalledWith({ type: "terminal-ack" });
    const stopping = handle.stop();
    expect(child.postMessage).toHaveBeenCalledWith({ type: "shutdown" });
    child.emit("exit", 0);
    await stopping;
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("uses one bounded kill fallback and still waits for observed exit", async () => {
    vi.useFakeTimers();
    const child = new FakeUtilityProcess();
    const fork = vi.mocked((await import("electron")).utilityProcess.fork);
    fork.mockReturnValue(child as never);
    const started = forkAppSupervisedDaemon({
      utilityEntry: "/synthetic/daemon-utility.js",
      homeRoot: "/synthetic/athlete",
    });
    child.emit("spawn");
    const handle = await started;
    const stopping = handle.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    await stopping;
    expect(child.kill).toHaveBeenCalledTimes(1);
  });
});
