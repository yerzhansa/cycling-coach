import { describe, expect, it } from "vitest";
import { createDesktopRendererNavigationTracker } from "../src/main/renderer-navigation-load.js";

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
});
