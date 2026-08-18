import { describe, expect, it, vi } from "vitest";
import {
  createDesktopRendererNavigationTracker,
  RENDERER_NAVIGATION_LOAD_ATTEMPTS,
} from "../src/main/renderer-navigation-load.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("desktop renderer navigation tracker", () => {
  it("waits for a replacement after the initial navigation is superseded", async () => {
    const tracker = createDesktopRendererNavigationTracker<object>();
    const window = {};
    const firstLoad = deferred<void>();
    const secondLoad = deferred<void>();
    const first = tracker.start(window, "first", () => firstLoad.promise);
    const waiting = tracker.waitForCurrent(first);
    tracker.start(window, "second", () => secondLoad.promise);
    firstLoad.reject(Object.assign(new Error("aborted"), { errno: -3, code: "ERR_ABORTED" }));

    let settled = false;
    void waiting.finally(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    secondLoad.resolve();
    await expect(waiting).resolves.toBeUndefined();
  });

  it("rejects when the current replacement fails", async () => {
    const tracker = createDesktopRendererNavigationTracker<object>();
    const window = {};
    const firstLoad = deferred<void>();
    const secondLoad = deferred<void>();
    const first = tracker.start(window, "first", () => firstLoad.promise);
    const waiting = tracker.waitForCurrent(first);
    tracker.start(window, "second", () => secondLoad.promise);
    firstLoad.reject(Object.assign(new Error("aborted"), { errno: -3, code: "ERR_ABORTED" }));
    const failure = new Error("replacement failed");
    secondLoad.reject(failure);

    await expect(waiting).rejects.toBe(failure);
  });

  it("rejects a failed navigation without a same-window replacement", async () => {
    const tracker = createDesktopRendererNavigationTracker<object>();
    const firstWindow = {};
    const secondWindow = {};
    const firstLoad = deferred<void>();
    const first = tracker.start(firstWindow, "first", () => firstLoad.promise);
    const waiting = tracker.waitForCurrent(first);
    tracker.start(secondWindow, "second", async () => {});
    const failure = new Error("first failed");
    firstLoad.reject(failure);

    await expect(waiting).rejects.toBe(failure);
  });

  it("retries a transient load failure until it succeeds", async () => {
    const retryDelay = vi.fn(async () => {});
    const tracker = createDesktopRendererNavigationTracker<object>({ retryDelay });
    const load = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("transient load failure"))
      .mockResolvedValueOnce(undefined);
    const navigation = tracker.start({}, "first", load);

    await expect(tracker.waitForCurrent(navigation)).resolves.toBeUndefined();
    expect(load).toHaveBeenCalledTimes(2);
    expect(retryDelay).toHaveBeenCalledTimes(1);
  });

  it("stops retrying after the attempt budget and rejects with the last failure", async () => {
    const tracker = createDesktopRendererNavigationTracker<object>({
      retryDelay: async () => {},
    });
    const failure = new Error("persistent load failure");
    const load = vi.fn<() => Promise<void>>().mockRejectedValue(failure);
    const navigation = tracker.start({}, "first", load);

    await expect(tracker.waitForCurrent(navigation)).rejects.toBe(failure);
    expect(load).toHaveBeenCalledTimes(RENDERER_NAVIGATION_LOAD_ATTEMPTS);
  });

  it("does not retry an aborted navigation", async () => {
    const tracker = createDesktopRendererNavigationTracker<object>({
      retryDelay: async () => {},
    });
    const abort = Object.assign(new Error("aborted"), { errno: -3, code: "ERR_ABORTED" });
    const load = vi.fn<() => Promise<void>>().mockRejectedValue(abort);
    const navigation = tracker.start({}, "first", load);

    await expect(navigation.task).rejects.toBe(abort);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("does not retry a navigation superseded during its retry delay", async () => {
    const delayGate = deferred<void>();
    const tracker = createDesktopRendererNavigationTracker<object>({
      retryDelay: () => delayGate.promise,
    });
    const window = {};
    const failure = new Error("transient load failure");
    const load = vi.fn<() => Promise<void>>().mockRejectedValue(failure);
    const first = tracker.start(window, "first", load);
    await Promise.resolve();

    tracker.start(window, "second", async () => {});
    delayGate.resolve();
    await expect(first.task).rejects.toBe(failure);
    expect(load).toHaveBeenCalledTimes(1);
  });
});
