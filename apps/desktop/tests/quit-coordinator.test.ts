import { describe, expect, it, vi } from "vitest";
import {
  completeDesktopShutdown,
  createDesktopQuitCoordinator,
} from "../src/main/quit-coordinator.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe("desktop quit coordinator", () => {
  it("blocks repeated pre-drain quits and permits only the updater-generated post-drain quit", async () => {
    const gate = deferred<void>();
    const drain = vi.fn(() => gate.promise);
    const exit = vi.fn();
    const first = { preventDefault: vi.fn() };
    const second = { preventDefault: vi.fn() };
    const updaterQuit = { preventDefault: vi.fn() };
    let coordinator!: ReturnType<typeof createDesktopQuitCoordinator>;
    const completeInstallAfterDrain = vi.fn((allowFinalQuit: () => void) => {
      allowFinalQuit();
      expect(coordinator.beforeQuit(updaterQuit)).toBe("allowed");
      return "started" as const;
    });
    coordinator = createDesktopQuitCoordinator({
      drain,
      updateController: { completeInstallAfterDrain },
      exit,
    });

    expect(coordinator.beforeQuit(first)).toBe("draining");
    expect(coordinator.beforeQuit(second)).toBe("draining");
    expect(first.preventDefault).toHaveBeenCalledOnce();
    expect(second.preventDefault).toHaveBeenCalledOnce();
    expect(drain).toHaveBeenCalledOnce();
    expect(completeInstallAfterDrain).not.toHaveBeenCalled();

    gate.resolve();
    await vi.waitFor(() => expect(completeInstallAfterDrain).toHaveBeenCalledOnce());

    expect(updaterQuit.preventDefault).not.toHaveBeenCalled();
    expect(drain).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalled();
  });

  it("permits a normal final exit only after a successful drain", async () => {
    const order: string[] = [];
    const exitEvent = { preventDefault: vi.fn() };
    let coordinator!: ReturnType<typeof createDesktopQuitCoordinator>;
    const exit = vi.fn((code: number) => {
      order.push(`exit:${code}`);
      expect(coordinator.beforeQuit(exitEvent)).toBe("allowed");
    });
    coordinator = createDesktopQuitCoordinator({
      drain: async () => {
        order.push("drain");
      },
      updateController: {
        completeInstallAfterDrain: () => {
          order.push("no-install");
          return "not-requested";
        },
      },
      exit,
    });

    coordinator.beforeQuit({ preventDefault: vi.fn() });
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));

    expect(order).toEqual(["drain", "no-install", "exit:0"]);
    expect(exitEvent.preventDefault).not.toHaveBeenCalled();
  });

  it("never permits install after drain rejection", async () => {
    const install = vi.fn(() => "started" as const);
    const exit = vi.fn();
    await completeDesktopShutdown({
      drain: async () => {
        throw new Error("synthetic drain failure");
      },
      updateController: { completeInstallAfterDrain: install },
      allowFinalQuit: vi.fn(),
      exit,
    });

    expect(install).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(1);
  });
});
