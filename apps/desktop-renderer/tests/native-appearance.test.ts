import { afterEach, describe, expect, it, vi } from "vitest";
import { bootTheme, useEnduragentStore } from "../src/state/store";
import { publishNativeAppearance } from "../src/theme/nativeAppearance";

function stubBridge(setAppearance: (appearance: string) => void): void {
  vi.stubGlobal("window", { enduragentAuth: { setAppearance } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  useEnduragentStore.setState({ appearance: "system" });
});

describe("native appearance forwarding", () => {
  it("forwards the appearance to the preload bridge", () => {
    const setAppearance = vi.fn();
    stubBridge(setAppearance);

    publishNativeAppearance("dark");
    publishNativeAppearance("light");
    publishNativeAppearance("system");

    expect(setAppearance.mock.calls).toEqual([["dark"], ["light"], ["system"]]);
  });

  it("stays silent when the desktop bridge is absent", () => {
    vi.stubGlobal("window", {});

    expect(() => publishNativeAppearance("dark")).not.toThrow();
  });

  it("contains a failing bridge call", () => {
    stubBridge(() => {
      throw new Error("synthetic bridge failure");
    });

    expect(() => publishNativeAppearance("dark")).not.toThrow();
  });

  it("tells the main process every time the athlete pins an appearance", () => {
    const setAppearance = vi.fn();
    stubBridge(setAppearance);

    useEnduragentStore.getState().setAppearance("dark");
    useEnduragentStore.getState().setAppearance("light");
    useEnduragentStore.getState().setAppearance("system");

    expect(setAppearance.mock.calls).toEqual([["dark"], ["light"], ["system"]]);
    expect(useEnduragentStore.getState().appearance).toBe("system");
  });

  it("tells the main process the stored appearance during boot", () => {
    const setAppearance = vi.fn();
    stubBridge(setAppearance);
    useEnduragentStore.setState({ appearance: "dark" });

    bootTheme();

    expect(setAppearance.mock.calls).toEqual([["dark"]]);
  });
});
