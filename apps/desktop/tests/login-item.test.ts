import { describe, expect, it, vi } from "vitest";
import {
  isCleanUnregisteredLoginItem,
  readLoginItemResidency,
  setLoginItemResidency,
  type LoginItemAppPort,
  type LoginItemResidencyState,
} from "../src/main/login-item.js";

function state(
  status: LoginItemResidencyState["status"],
  openAtLogin = false,
  executableWillLaunchAtLogin = false,
) {
  return {
    openAtLogin,
    executableWillLaunchAtLogin,
    status,
    launchItems: [{ name: "ignored", path: "/ignored", type: "mainAppService" as const }],
    wasOpenedAtLogin: true,
    wasOpenedAsHidden: true,
    restoreState: true,
  };
}

describe("login-item residency", () => {
  it("reads with no options and projects only authoritative fields", () => {
    const getLoginItemSettings = vi.fn(() => state("requires-approval", true, false));
    const app = { getLoginItemSettings, setLoginItemSettings: vi.fn() } as never;
    expect(readLoginItemResidency(app)).toEqual({
      openAtLogin: true,
      executableWillLaunchAtLogin: false,
      status: "requires-approval",
    });
    expect(getLoginItemSettings).toHaveBeenCalledOnce();
    expect(getLoginItemSettings).toHaveBeenCalledWith();
    expect(Object.keys(readLoginItemResidency(app))).toEqual([
      "openAtLogin",
      "executableWillLaunchAtLogin",
      "status",
    ]);
  });

  it.each([true, false])("sets only openAtLogin=%s and immediately reads truth", (openAtLogin) => {
    const setLoginItemSettings = vi.fn();
    const getLoginItemSettings = vi.fn(() =>
      state(openAtLogin ? "enabled" : "not-registered", openAtLogin, openAtLogin),
    );
    const app = { getLoginItemSettings, setLoginItemSettings } as never;
    expect(setLoginItemResidency(app, openAtLogin).openAtLogin).toBe(openAtLogin);
    expect(setLoginItemSettings).toHaveBeenCalledOnce();
    expect(setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin });
    expect(Object.keys(setLoginItemSettings.mock.calls[0]?.[0] ?? {})).toEqual(["openAtLogin"]);
    expect(getLoginItemSettings).toHaveBeenCalledOnce();
    expect(getLoginItemSettings).toHaveBeenCalledWith();
  });

  it("accepts both clean statuses and rejects every active observation", () => {
    expect(isCleanUnregisteredLoginItem(state("not-found") as never)).toBe(true);
    expect(isCleanUnregisteredLoginItem(state("not-registered") as never)).toBe(true);
    for (const value of [
      state("not-found", true, false),
      state("not-found", false, true),
      state("enabled"),
      state("requires-approval"),
    ]) {
      expect(isCleanUnregisteredLoginItem(value as never)).toBe(false);
    }
  });

  it("propagates getter and setter errors without a fallback", () => {
    const getterError = new Error("private getter detail");
    const setterError = new Error("private setter detail");
    const getApp: LoginItemAppPort = {
      getLoginItemSettings: vi.fn(() => {
        throw getterError;
      }),
      setLoginItemSettings: vi.fn(),
    } as never;
    const setApp: LoginItemAppPort = {
      getLoginItemSettings: vi.fn(() => state("not-found")),
      setLoginItemSettings: vi.fn(() => {
        throw setterError;
      }),
    } as never;
    expect(() => readLoginItemResidency(getApp)).toThrow(getterError);
    expect(() => setLoginItemResidency(setApp, true)).toThrow(setterError);
    expect(setApp.getLoginItemSettings).not.toHaveBeenCalled();
  });
});
