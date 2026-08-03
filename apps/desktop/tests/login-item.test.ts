import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BACKGROUND_AT_LOGIN_PREFERENCE_FILE_NAME,
  createBackgroundAtLoginPreferenceStore,
  isCleanUnregisteredLoginItem,
  LOGIN_ITEM_PREFERENCE_DIRECTORY_MODE,
  LOGIN_ITEM_PREFERENCE_FILE_MODE,
  readLoginItemResidency,
  setLoginItemResidency,
  shouldStartInBackgroundAtLogin,
  type LoginItemAppPort,
  type LoginItemResidencyState,
} from "../src/main/login-item.js";

const scratchDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    scratchDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function scratch(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "enduragent-login-item-"));
  scratchDirectories.push(path);
  return path;
}

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

describe("background-at-login preference", () => {
  it("defaults to foreground and persists only the explicit background preference", async () => {
    const root = join(await scratch(), "preferences");
    const store = createBackgroundAtLoginPreferenceStore({ root, createId: () => "first" });

    await expect(store.read()).resolves.toEqual({ state: "configured", enabled: false });
    await expect(store.set(true)).resolves.toEqual({ status: "stored", enabled: true });
    await expect(store.read()).resolves.toEqual({ state: "configured", enabled: true });

    const target = join(root, BACKGROUND_AT_LOGIN_PREFERENCE_FILE_NAME);
    expect((await stat(root)).mode & 0o777).toBe(LOGIN_ITEM_PREFERENCE_DIRECTORY_MODE);
    expect((await stat(target)).mode & 0o777).toBe(LOGIN_ITEM_PREFERENCE_FILE_MODE);
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual({
      schemaVersion: 1,
      enabled: true,
    });
  });

  it("starts in background only for an OS-login launch with the preference enabled", async () => {
    const read = vi.fn(async () => ({ state: "configured", enabled: true }) as const);
    const manualLaunch = {
      getLoginItemSettings: vi.fn(() => state("enabled", true, true)),
    };
    const loginLaunch = {
      getLoginItemSettings: vi.fn(() => state("enabled", true, true)),
    };
    manualLaunch.getLoginItemSettings.mockReturnValue({
      ...state("enabled", true, true),
      wasOpenedAtLogin: false,
    });

    await expect(shouldStartInBackgroundAtLogin(manualLaunch as never, { read })).resolves.toBe(
      false,
    );
    expect(read).not.toHaveBeenCalled();
    await expect(shouldStartInBackgroundAtLogin(loginLaunch as never, { read })).resolves.toBe(
      true,
    );
    expect(read).toHaveBeenCalledOnce();
  });

  it("does not treat deprecated hidden-launch observations as permission", async () => {
    const app = {
      getLoginItemSettings: vi.fn(() => ({
        ...state("enabled", true, true),
        wasOpenedAtLogin: true,
        wasOpenedAsHidden: true,
      })),
    };
    await expect(
      shouldStartInBackgroundAtLogin(app as never, {
        read: async () => ({ state: "configured", enabled: false }),
      }),
    ).resolves.toBe(false);
  });

  it("fails closed for malformed, permissive, and non-boolean preference state", async () => {
    const root = join(await scratch(), "preferences");
    const first = createBackgroundAtLoginPreferenceStore({ root, createId: () => "seed" });
    await expect(first.set(true)).resolves.toEqual({ status: "stored", enabled: true });
    const target = join(root, BACKGROUND_AT_LOGIN_PREFERENCE_FILE_NAME);

    await chmod(target, 0o644);
    await expect(first.read()).resolves.toEqual({ state: "unavailable", enabled: false });
    await chmod(target, LOGIN_ITEM_PREFERENCE_FILE_MODE);
    await writeFile(target, '{"schemaVersion":1,"enabled":"true"}\n', { mode: 0o600 });
    await expect(first.read()).resolves.toEqual({ state: "unavailable", enabled: false });
  });

  it("never changes OS login registration when the background preference changes", async () => {
    const root = join(await scratch(), "preferences");
    const setLoginItemSettings = vi.fn();
    const app = {
      getLoginItemSettings: vi.fn(() => ({
        ...state("not-registered"),
        wasOpenedAtLogin: false,
      })),
      setLoginItemSettings,
    };
    const store = createBackgroundAtLoginPreferenceStore({ root, createId: () => "explicit" });

    await expect(store.set(true)).resolves.toEqual({ status: "stored", enabled: true });
    await expect(shouldStartInBackgroundAtLogin(app as never, store)).resolves.toBe(false);
    expect(setLoginItemSettings).not.toHaveBeenCalled();
  });
});
