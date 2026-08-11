import {
  chmod,
  lstat,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DESKTOP_APP_USER_MODEL_ID } from "../src/main/constants.js";
import {
  BACKGROUND_AT_LOGIN_PREFERENCE_FILE_NAME,
  createBackgroundAtLoginPreferenceStore,
  isCleanUnregisteredLoginItem,
  LOGIN_ITEM_PREFERENCE_DIRECTORY_MODE,
  LOGIN_ITEM_PREFERENCE_FILE_MODE,
  isLoginItemResidencyEnabled,
  loginItemResidencyMatchesRequest,
  readLoginItemResidency,
  setLoginItemResidency,
  shouldStartInBackgroundAtLogin,
  WINDOWS_BACKGROUND_AT_LOGIN_ARGUMENT,
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

async function publishUnsyncedPreference(root: string, enabled: boolean): Promise<void> {
  const target = join(root, BACKGROUND_AT_LOGIN_PREFERENCE_FILE_NAME);
  const temporary = join(root, `.${BACKGROUND_AT_LOGIN_PREFERENCE_FILE_NAME}.crash.tmp`);
  const handle = await open(temporary, "wx", LOGIN_ITEM_PREFERENCE_FILE_MODE);
  try {
    await handle.writeFile(`${JSON.stringify({ schemaVersion: 1, enabled })}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, target);
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

  it("reads the exact argument-marked Windows registration", () => {
    const executablePath = String.raw`C:\Users\Athlete\AppData\Local\Programs\Enduragent\Enduragent.exe`;
    const getLoginItemSettings = vi.fn(() => state("enabled", true, true));
    const app = { getLoginItemSettings } as never;

    expect(readLoginItemResidency(app, { platform: "win32", executablePath })).toEqual({
      openAtLogin: true,
      executableWillLaunchAtLogin: true,
      status: "enabled",
    });
    expect(getLoginItemSettings).toHaveBeenCalledWith({
      path: executablePath,
      args: [WINDOWS_BACKGROUND_AT_LOGIN_ARGUMENT],
    });
  });

  it.each([true, false])(
    "writes and verifies the named per-user Windows registration when enabled=%s",
    (openAtLogin) => {
      const executablePath = String.raw`C:\Program Files\Enduragent\Enduragent.exe`;
      const setLoginItemSettings = vi.fn();
      const getLoginItemSettings = vi.fn(() =>
        state(openAtLogin ? "enabled" : "not-registered", openAtLogin, openAtLogin),
      );
      const app = { getLoginItemSettings, setLoginItemSettings } as never;

      const observed = setLoginItemResidency(app, openAtLogin, {
        platform: "win32",
        executablePath,
      });

      expect(setLoginItemSettings).toHaveBeenCalledWith({
        openAtLogin,
        path: executablePath,
        args: [WINDOWS_BACKGROUND_AT_LOGIN_ARGUMENT],
        enabled: openAtLogin,
        name: DESKTOP_APP_USER_MODEL_ID,
      });
      expect(getLoginItemSettings).toHaveBeenCalledWith({
        path: executablePath,
        args: [WINDOWS_BACKGROUND_AT_LOGIN_ARGUMENT],
      });
      expect(loginItemResidencyMatchesRequest(observed, openAtLogin, "win32")).toBe(true);
    },
  );

  it("treats an OS-disabled Windows startup entry as off without hiding its registration", () => {
    const disabled = state("enabled", true, false) as never;

    expect(isLoginItemResidencyEnabled(disabled, "win32")).toBe(false);
    expect(loginItemResidencyMatchesRequest(disabled, true, "win32")).toBe(false);
    expect(loginItemResidencyMatchesRequest(disabled, false, "win32")).toBe(false);
  });
});

describe("background-at-login preference", () => {
  it("defaults to foreground and persists a restart-safe background preference", async () => {
    const root = join(await scratch(), "preferences");
    const store = createBackgroundAtLoginPreferenceStore({ root, createId: () => "first" });

    await expect(store.read()).resolves.toEqual({ state: "configured", enabled: false });
    await expect(store.set(true)).resolves.toEqual({ status: "stored", enabled: true });
    await expect(store.read()).resolves.toEqual({
      state: "configured",
      enabled: true,
      loginLaunchBehavior: "background",
    });

    const target = join(root, BACKGROUND_AT_LOGIN_PREFERENCE_FILE_NAME);
    expect((await stat(root)).mode & 0o777).toBe(LOGIN_ITEM_PREFERENCE_DIRECTORY_MODE);
    expect((await stat(target)).mode & 0o777).toBe(LOGIN_ITEM_PREFERENCE_FILE_MODE);
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual({
      schemaVersion: 2,
      enabled: true,
      loginLaunchBehavior: "background",
    });
  });

  it("anchors a newly created preference namespace before publishing state", async () => {
    const root = join(await scratch(), "preferences");
    const syncParentDirectory = vi.fn(async (path: string) => {
      expect(path).toBe(dirname(root));
      throw new TypeError("synthetic parent sync failure");
    });
    const store = createBackgroundAtLoginPreferenceStore({ root, syncParentDirectory });

    await expect(store.set(true)).resolves.toEqual({ status: "refused" });
    await expect(lstat(join(root, BACKGROUND_AT_LOGIN_PREFERENCE_FILE_NAME))).rejects.toMatchObject(
      {
        code: "ENOENT",
      },
    );
    expect(syncParentDirectory).toHaveBeenCalledOnce();
  });

  it("restores the previous preference before refusing a post-rename durability failure", async () => {
    const root = join(await scratch(), "preferences");
    const seed = createBackgroundAtLoginPreferenceStore({ root, createId: () => "seed" });
    await seed.set(false);
    let syncCount = 0;
    const store = createBackgroundAtLoginPreferenceStore({
      root,
      createId: () => `write-${syncCount}`,
      syncDirectory: async () => {
        syncCount += 1;
        if (syncCount === 2) throw new TypeError("synthetic replacement sync failure");
        const directory = await open(root, "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      },
    });

    await expect(store.set(true)).resolves.toEqual({ status: "refused" });
    await expect(store.read()).resolves.toEqual({
      state: "configured",
      enabled: false,
      loginLaunchBehavior: "background",
    });
  });

  it("fails closed with explicit uncertainty when preference convergence cannot be proven", async () => {
    const root = join(await scratch(), "preferences");
    const seed = createBackgroundAtLoginPreferenceStore({ root, createId: () => "seed" });
    await seed.set(false);
    const store = createBackgroundAtLoginPreferenceStore({
      root,
      createId: () => "never-durable",
      syncDirectory: async () => {
        throw new TypeError("synthetic persistent directory sync failure");
      },
    });

    await expect(store.set(true)).resolves.toEqual({ status: "uncertain" });
    await expect(store.read()).resolves.toEqual({ state: "uncertain", enabled: false });
  });

  it.each([
    ["prior", false],
    ["candidate", true],
  ] as const)(
    "fsyncs and accepts the visible %s preference after reconstructing the store",
    async (_state, enabled) => {
      const root = join(await scratch(), "preferences");
      const seed = createBackgroundAtLoginPreferenceStore({ root, createId: () => "seed" });
      await expect(seed.set(!enabled)).resolves.toEqual({
        status: "stored",
        enabled: !enabled,
      });
      await publishUnsyncedPreference(root, enabled);
      const syncDirectory = vi.fn(async () => {
        const directory = await open(root, "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      });
      const reopened = createBackgroundAtLoginPreferenceStore({ root, syncDirectory });

      await expect(reopened.read()).resolves.toEqual({ state: "configured", enabled });
      expect(syncDirectory).toHaveBeenCalledOnce();
    },
  );

  it("keeps an uncertain login launch in the background without trusting visible state", async () => {
    const root = join(await scratch(), "preferences");
    const seed = createBackgroundAtLoginPreferenceStore({ root, createId: () => "seed" });
    await expect(seed.set(false)).resolves.toEqual({ status: "stored", enabled: false });
    await publishUnsyncedPreference(root, true);
    const syncDirectory = vi.fn(async () => {
      throw new TypeError("synthetic reopen sync failure");
    });
    const reopened = createBackgroundAtLoginPreferenceStore({ root, syncDirectory });

    await expect(reopened.read()).resolves.toEqual({ state: "uncertain", enabled: false });
    await expect(reopened.set(false)).resolves.toEqual({ status: "uncertain" });
    await expect(
      shouldStartInBackgroundAtLogin(
        { getLoginItemSettings: () => ({ wasOpenedAtLogin: true }) } as never,
        reopened,
      ),
    ).resolves.toBe(true);
    expect(syncDirectory).toHaveBeenCalledOnce();
  });

  it("cleans exact owned crash artifacts without touching namespace lookalikes", async () => {
    const root = join(await scratch(), "preferences");
    const seed = createBackgroundAtLoginPreferenceStore({ root, createId: () => "seed" });
    await seed.set(false);
    const owned = `.${BACKGROUND_AT_LOGIN_PREFERENCE_FILE_NAME}.owned.tmp`;
    const lookalike = `${owned}.backup`;
    await writeFile(join(root, owned), "synthetic-owned-artifact", {
      mode: LOGIN_ITEM_PREFERENCE_FILE_MODE,
    });
    await writeFile(join(root, lookalike), "synthetic-user-file", {
      mode: LOGIN_ITEM_PREFERENCE_FILE_MODE,
    });
    const removeFile = vi.fn(async (path: string, options: { force?: boolean }) => {
      await rm(path, options);
    });
    const reopened = createBackgroundAtLoginPreferenceStore({
      root,
      removeFile: removeFile as never,
    });

    await expect(reopened.read()).resolves.toEqual({
      state: "configured",
      enabled: false,
      loginLaunchBehavior: "background",
    });
    await expect(lstat(join(root, owned))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(root)).sort()).toEqual(
      [BACKGROUND_AT_LOGIN_PREFERENCE_FILE_NAME, lookalike].sort(),
    );
    expect(removeFile).toHaveBeenCalledOnce();
  });

  it("latches exact crash-artifact cleanup failure as permanent store uncertainty", async () => {
    const root = join(await scratch(), "preferences");
    const seed = createBackgroundAtLoginPreferenceStore({ root, createId: () => "seed" });
    await seed.set(true);
    const owned = join(root, `.${BACKGROUND_AT_LOGIN_PREFERENCE_FILE_NAME}.owned.deleted`);
    await writeFile(owned, "synthetic-owned-artifact", {
      mode: LOGIN_ITEM_PREFERENCE_FILE_MODE,
    });
    let cleanupAvailable = false;
    const removeFile = vi.fn(async (path: string, options: { force?: boolean }) => {
      if (!cleanupAvailable) throw new TypeError("synthetic cleanup failure");
      await rm(path, options);
    });
    const reopened = createBackgroundAtLoginPreferenceStore({
      root,
      removeFile: removeFile as never,
    });

    await expect(reopened.read()).resolves.toEqual({ state: "uncertain", enabled: false });
    cleanupAvailable = true;
    await expect(reopened.read()).resolves.toEqual({ state: "uncertain", enabled: false });
    expect(removeFile).toHaveBeenCalledOnce();
    expect((await lstat(owned)).isFile()).toBe(true);
  });

  it("persists the Windows preference without POSIX ownership or directory sync", async () => {
    const root = join(await scratch(), "preferences");
    const synchronizeDirectory = vi.fn(async () => {
      throw new TypeError("Windows directory sync must stay unavailable");
    });
    const synchronizeParentDirectory = vi.fn(async () => {
      throw new TypeError("Windows parent sync must stay unavailable");
    });
    const store = createBackgroundAtLoginPreferenceStore({
      root,
      platform: "win32",
      createId: () => "windows-preference",
      syncDirectory: synchronizeDirectory,
      syncParentDirectory: synchronizeParentDirectory,
    });

    await expect(store.set(true)).resolves.toEqual({ status: "stored", enabled: true });
    const target = join(root, BACKGROUND_AT_LOGIN_PREFERENCE_FILE_NAME);
    await chmod(root, 0o755);
    await chmod(target, 0o644);
    const reopened = createBackgroundAtLoginPreferenceStore({
      root,
      platform: "win32",
      syncDirectory: synchronizeDirectory,
      syncParentDirectory: synchronizeParentDirectory,
    });
    await expect(reopened.read()).resolves.toEqual({
      state: "configured",
      enabled: true,
      loginLaunchBehavior: "background",
    });
    expect(synchronizeDirectory).not.toHaveBeenCalled();
    expect(synchronizeParentDirectory).not.toHaveBeenCalled();

    await writeFile(target, '{"schemaVersion":2}\n');
    await expect(reopened.read()).resolves.toEqual({ state: "unavailable", enabled: false });
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

  it("starts in the Windows background only for the exact enabled login invocation", async () => {
    const executablePath = String.raw`C:\Users\Athlete\Enduragent.exe`;
    const read = vi.fn(async () => ({ state: "configured", enabled: true }) as const);
    const getLoginItemSettings = vi.fn(() => state("enabled", true, true));
    const app = { getLoginItemSettings } as never;

    await expect(
      shouldStartInBackgroundAtLogin(
        app,
        { read },
        {
          platform: "win32",
          executablePath,
          commandLine: [executablePath],
        },
      ),
    ).resolves.toBe(false);
    expect(getLoginItemSettings).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();

    await expect(
      shouldStartInBackgroundAtLogin(
        app,
        { read },
        {
          platform: "win32",
          executablePath,
          commandLine: [executablePath, WINDOWS_BACKGROUND_AT_LOGIN_ARGUMENT],
        },
      ),
    ).resolves.toBe(true);
    expect(getLoginItemSettings).toHaveBeenCalledWith({
      path: executablePath,
      args: [WINDOWS_BACKGROUND_AT_LOGIN_ARGUMENT],
    });
    expect(read).toHaveBeenCalledOnce();

    getLoginItemSettings.mockReturnValueOnce(state("enabled", true, false));
    await expect(
      shouldStartInBackgroundAtLogin(
        app,
        { read },
        {
          platform: "win32",
          executablePath,
          commandLine: [WINDOWS_BACKGROUND_AT_LOGIN_ARGUMENT],
        },
      ),
    ).resolves.toBe(false);
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
    await writeFile(
      target,
      '{"schemaVersion":2,"enabled":false,"loginLaunchBehavior":"foreground"}\n',
      { mode: 0o600 },
    );
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
