import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { DESKTOP_RENDERER_URL } from "../src/main/constants.js";
import {
  createSessionTimezoneNoticeStore,
  installDesktopSessionTimezoneIpc,
} from "../src/main/session-timezone-ipc.js";
import {
  chooseSessionTimezoneMode,
  decideSessionTimezoneAtStart,
  readSessionTimezoneMode,
  readSessionTimezoneSetting,
  recordFirstRunSessionTimezoneMode,
  reconcileSessionTimezoneAtStart,
  sessionTimezoneModePath,
  type DesktopSessionTimezoneNotice,
} from "../src/main/session-timezone.js";

const HARARE = "Africa/Harare";
const QYZYLORDA = "Asia/Qyzylorda";
const LISBON = "Europe/Lisbon";

async function createInstall(storedTimezone: string): Promise<{
  readonly configPath: string;
  readonly stateRoot: string;
  readonly read: () => Promise<string>;
  readonly storedZone: () => Promise<unknown>;
}> {
  const root = await mkdtemp(join(tmpdir(), "session-timezone-"));
  const configDirectory = join(root, "config");
  await mkdir(configDirectory, { recursive: true });
  const configPath = join(configDirectory, "config.yaml");
  await writeFile(
    configPath,
    [
      "data_source: store",
      "session:",
      `  timezone: ${storedTimezone}`,
      "  daily_reset_hour: 4",
      "",
    ].join("\n"),
    "utf8",
  );
  const stateRoot = join(root, "preferences");
  await mkdir(stateRoot, { recursive: true });
  const read = () => readFile(configPath, "utf8");
  return {
    configPath,
    stateRoot,
    read,
    storedZone: async () => {
      const document = parseYaml(await read()) as { readonly session?: { timezone?: unknown } };
      return document.session?.timezone;
    },
  };
}

describe("desktop session timezone start behaviour", () => {
  it("adopts the host zone on the next start while the athlete follows this computer", async () => {
    const install = await createInstall(HARARE);
    expect(
      await chooseSessionTimezoneMode({ stateRoot: install.stateRoot, mode: "follow", env: {} }),
    ).toBe(true);

    const notice = await reconcileSessionTimezoneAtStart({
      configPath: install.configPath,
      stateRoot: install.stateRoot,
      env: {},
      hostTimezone: () => QYZYLORDA,
    });

    expect(notice).toEqual({ status: "none" });
    expect(await install.storedZone()).toBe(QYZYLORDA);
    expect(await readSessionTimezoneMode(install.stateRoot)).toBe("follow");
  });

  it("never touches a fixed zone the athlete pinned while it already equalled the host", async () => {
    const install = await createInstall(LISBON);
    const setting = await readSessionTimezoneSetting({
      stateRoot: install.stateRoot,
      env: {},
      hostTimezone: () => LISBON,
    });
    expect(setting).toEqual({ status: "editable", mode: null, host: LISBON });

    expect(
      await chooseSessionTimezoneMode({ stateRoot: install.stateRoot, mode: "fixed", env: {} }),
    ).toBe(true);
    const before = await install.read();

    const notice = await reconcileSessionTimezoneAtStart({
      configPath: install.configPath,
      stateRoot: install.stateRoot,
      env: {},
      hostTimezone: () => QYZYLORDA,
    });

    expect(notice).toEqual({ status: "none" });
    expect(await install.read()).toBe(before);
    expect(await install.storedZone()).toBe(LISBON);
    expect(await readSessionTimezoneMode(install.stateRoot)).toBe("fixed");
  });

  it("asks once when nothing is persisted, and keeping the stored zone persists the choice", async () => {
    const install = await createInstall(HARARE);
    const before = await install.read();

    const first = await reconcileSessionTimezoneAtStart({
      configPath: install.configPath,
      stateRoot: install.stateRoot,
      env: {},
      hostTimezone: () => QYZYLORDA,
    });

    expect(first).toEqual({ status: "reconcile", stored: HARARE, host: QYZYLORDA });
    expect(await install.read()).toBe(before);
    expect(await readSessionTimezoneMode(install.stateRoot)).toBeUndefined();

    expect(
      await chooseSessionTimezoneMode({ stateRoot: install.stateRoot, mode: "fixed", env: {} }),
    ).toBe(true);
    const afterKeeping = await reconcileSessionTimezoneAtStart({
      configPath: install.configPath,
      stateRoot: install.stateRoot,
      env: {},
      hostTimezone: () => QYZYLORDA,
    });
    expect(afterKeeping).toEqual({ status: "none" });
    expect(await install.read()).toBe(before);
  });

  it("stops asking once the athlete answers with this computer's zone", async () => {
    const install = await createInstall(HARARE);

    expect(
      await reconcileSessionTimezoneAtStart({
        configPath: install.configPath,
        stateRoot: install.stateRoot,
        env: {},
        hostTimezone: () => QYZYLORDA,
      }),
    ).toEqual({ status: "reconcile", stored: HARARE, host: QYZYLORDA });

    expect(
      await chooseSessionTimezoneMode({ stateRoot: install.stateRoot, mode: "follow", env: {} }),
    ).toBe(true);
    const afterAdopting = await reconcileSessionTimezoneAtStart({
      configPath: install.configPath,
      stateRoot: install.stateRoot,
      env: {},
      hostTimezone: () => QYZYLORDA,
    });

    expect(afterAdopting).toEqual({ status: "none" });
    expect(await install.storedZone()).toBe(QYZYLORDA);
    expect(
      await reconcileSessionTimezoneAtStart({
        configPath: install.configPath,
        stateRoot: install.stateRoot,
        env: {},
        hostTimezone: () => QYZYLORDA,
      }),
    ).toEqual({ status: "none" });
  });

  it("falls back exactly as before when the stored zone is invalid, with no notice", async () => {
    const install = await createInstall("Not/AZone");
    const before = await install.read();

    const notice = await reconcileSessionTimezoneAtStart({
      configPath: install.configPath,
      stateRoot: install.stateRoot,
      env: {},
      hostTimezone: () => QYZYLORDA,
    });

    expect(notice).toEqual({ status: "none" });
    expect(await install.read()).toBe(before);
    expect(await readSessionTimezoneMode(install.stateRoot)).toBeUndefined();
  });

  it("takes the mode as an input and never returns one", () => {
    expect(
      decideSessionTimezoneAtStart({ environmentManaged: false, mode: null, stored: LISBON, host: LISBON }),
    ).toEqual({ kind: "idle", reason: "unanswered-and-equal" });
    expect(
      decideSessionTimezoneAtStart({
        environmentManaged: false,
        mode: null,
        stored: HARARE,
        host: QYZYLORDA,
      }),
    ).toEqual({ kind: "reconcile", stored: HARARE, host: QYZYLORDA });
    expect(
      decideSessionTimezoneAtStart({
        environmentManaged: false,
        mode: "fixed",
        stored: LISBON,
        host: LISBON,
      }),
    ).toEqual({ kind: "idle", reason: "fixed" });
    expect(
      decideSessionTimezoneAtStart({
        environmentManaged: true,
        mode: "follow",
        stored: HARARE,
        host: QYZYLORDA,
      }),
    ).toEqual({ kind: "idle", reason: "environment-managed" });
    for (const decision of [
      decideSessionTimezoneAtStart({
        environmentManaged: false,
        mode: "follow",
        stored: HARARE,
        host: QYZYLORDA,
      }),
      decideSessionTimezoneAtStart({
        environmentManaged: false,
        mode: null,
        stored: HARARE,
        host: QYZYLORDA,
      }),
    ]) {
      expect(Object.keys(decision).includes("mode")).toBe(false);
      expect(Object.keys(decision).includes("source")).toBe(false);
    }
  });

  it("repairs an unusable stored zone while following this computer", () => {
    expect(
      decideSessionTimezoneAtStart({
        environmentManaged: false,
        mode: "follow",
        stored: "Not/AZone",
        host: QYZYLORDA,
      }),
    ).toEqual({ kind: "adopt", timezone: QYZYLORDA });
    expect(
      decideSessionTimezoneAtStart({
        environmentManaged: false,
        mode: "follow",
        stored: "",
        host: QYZYLORDA,
      }),
    ).toEqual({ kind: "adopt", timezone: QYZYLORDA });
  });

  it("still leaves an unusable stored zone alone when nobody has answered", () => {
    expect(
      decideSessionTimezoneAtStart({
        environmentManaged: false,
        mode: null,
        stored: "Not/AZone",
        host: QYZYLORDA,
      }),
    ).toEqual({ kind: "idle", reason: "stored-invalid" });
    expect(
      decideSessionTimezoneAtStart({
        environmentManaged: false,
        mode: null,
        stored: "",
        host: QYZYLORDA,
      }),
    ).toEqual({ kind: "idle", reason: "stored-missing" });
  });
});

describe("desktop session timezone persisted mode", () => {
  it("defaults a freshly seeded install to following this computer", async () => {
    const install = await createInstall(HARARE);
    expect(
      await recordFirstRunSessionTimezoneMode({
        stateRoot: install.stateRoot,
        seeded: "seeded",
        env: {},
      }),
    ).toBe(true);
    expect(await readSessionTimezoneMode(install.stateRoot)).toBe("follow");
  });

  it("never overwrites a mode the athlete already chose, even when the config is reseeded", async () => {
    const install = await createInstall(HARARE);
    expect(
      await chooseSessionTimezoneMode({ stateRoot: install.stateRoot, mode: "fixed", env: {} }),
    ).toBe(true);
    expect(
      await recordFirstRunSessionTimezoneMode({
        stateRoot: install.stateRoot,
        seeded: "seeded",
        env: {},
      }),
    ).toBe(false);
    expect(await readSessionTimezoneMode(install.stateRoot)).toBe("fixed");
  });

  it("writes nothing when the config already existed", async () => {
    const install = await createInstall(HARARE);
    expect(
      await recordFirstRunSessionTimezoneMode({
        stateRoot: install.stateRoot,
        seeded: "existing",
        env: {},
      }),
    ).toBe(false);
    expect(await readSessionTimezoneMode(install.stateRoot)).toBeUndefined();
  });

  it("refuses every write path and reports environment ownership when COACH_TZ is set", async () => {
    const install = await createInstall(HARARE);
    const before = await install.read();
    const env = { COACH_TZ: "Europe/Berlin" };

    expect(
      await recordFirstRunSessionTimezoneMode({
        stateRoot: install.stateRoot,
        seeded: "seeded",
        env,
      }),
    ).toBe(false);
    expect(await chooseSessionTimezoneMode({ stateRoot: install.stateRoot, mode: "fixed", env })).toBe(
      false,
    );
    expect(
      await chooseSessionTimezoneMode({ stateRoot: install.stateRoot, mode: "follow", env }),
    ).toBe(false);
    expect(
      await reconcileSessionTimezoneAtStart({
        configPath: install.configPath,
        stateRoot: install.stateRoot,
        env,
        hostTimezone: () => QYZYLORDA,
      }),
    ).toEqual({ status: "none" });

    expect(await install.read()).toBe(before);
    expect(await readSessionTimezoneMode(install.stateRoot)).toBeUndefined();
    await expect(readFile(sessionTimezoneModePath(install.stateRoot), "utf8")).rejects.toThrow();
    expect(
      await readSessionTimezoneSetting({
        stateRoot: install.stateRoot,
        env,
        hostTimezone: () => QYZYLORDA,
      }),
    ).toEqual({ status: "environment-managed", timezone: "Europe/Berlin" });
  });

  it("still lets the environment own an empty COACH_TZ, naming the zone the engine falls back to", async () => {
    const install = await createInstall(HARARE);
    const env = { COACH_TZ: "" };
    expect(
      await readSessionTimezoneSetting({
        stateRoot: install.stateRoot,
        env,
        hostTimezone: () => QYZYLORDA,
      }),
    ).toEqual({ status: "environment-managed", timezone: QYZYLORDA });
    expect(await chooseSessionTimezoneMode({ stateRoot: install.stateRoot, mode: "fixed", env })).toBe(
      false,
    );
    expect(await readSessionTimezoneMode(install.stateRoot)).toBeUndefined();
  });

  it("reports an unusable host zone as no host rather than guessing", async () => {
    const install = await createInstall(HARARE);
    expect(
      await readSessionTimezoneSetting({
        stateRoot: install.stateRoot,
        env: {},
        hostTimezone: () => "Not/AZone",
      }),
    ).toEqual({ status: "editable", mode: null, host: null });
  });
});

describe("desktop session timezone ipc", () => {
  function installIpc(input: {
    readonly initial: DesktopSessionTimezoneNotice;
    readonly stateRoot: string;
    readonly env?: Record<string, string | undefined>;
  }) {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const notices = createSessionTimezoneNoticeStore();
    notices.set(input.initial);
    const mainFrame = { url: DESKTOP_RENDERER_URL };
    const webContents = { isDestroyed: () => false, mainFrame };
    const window = { isDestroyed: () => false, webContents } as never;
    const env = input.env ?? {};
    const dispose = installDesktopSessionTimezoneIpc({
      ipcMain: {
        handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
          handlers.set(channel, handler);
        },
        removeHandler: (channel: string) => {
          handlers.delete(channel);
        },
      } as never,
      currentWindow: () => window,
      notices,
      readSetting: () =>
        readSessionTimezoneSetting({
          stateRoot: input.stateRoot,
          env,
          hostTimezone: () => QYZYLORDA,
        }),
      chooseMode: (mode) => chooseSessionTimezoneMode({ stateRoot: input.stateRoot, mode, env }),
    });
    const event = { sender: webContents, senderFrame: mainFrame } as never;
    return { handlers, dispose, event, notices };
  }

  it("rejects an unrecognised mode instead of writing one", async () => {
    const install = await createInstall(HARARE);
    const ipc = installIpc({
      initial: { status: "reconcile", stored: HARARE, host: QYZYLORDA },
      stateRoot: install.stateRoot,
    });
    const choose = ipc.handlers.get("desktop:session-timezone:mode");
    expect(choose).toBeDefined();
    await expect(Promise.resolve(choose?.(ipc.event, "somewhere-else"))).rejects.toBeInstanceOf(
      TypeError,
    );
    expect(await readSessionTimezoneMode(install.stateRoot)).toBeUndefined();
    ipc.dispose();
  });

  it("clears the notice only when the chosen mode was persisted", async () => {
    const install = await createInstall(HARARE);
    const ipc = installIpc({
      initial: { status: "reconcile", stored: HARARE, host: QYZYLORDA },
      stateRoot: install.stateRoot,
    });
    const choose = ipc.handlers.get("desktop:session-timezone:mode");
    expect(await choose?.(ipc.event, "fixed")).toBe(true);
    expect(ipc.notices.read()).toEqual({ status: "none" });
    ipc.dispose();

    const refused = await createInstall(HARARE);
    const guarded = installIpc({
      initial: { status: "reconcile", stored: HARARE, host: QYZYLORDA },
      stateRoot: refused.stateRoot,
      env: { COACH_TZ: "Europe/Berlin" },
    });
    const guardedChoose = guarded.handlers.get("desktop:session-timezone:mode");
    expect(await guardedChoose?.(guarded.event, "fixed")).toBe(false);
    expect(guarded.notices.read()).toEqual({
      status: "reconcile",
      stored: HARARE,
      host: QYZYLORDA,
    });
    expect(await readSessionTimezoneMode(refused.stateRoot)).toBeUndefined();
    guarded.dispose();
  });

  it("serves the persisted setting to the settings control", async () => {
    const install = await createInstall(HARARE);
    const ipc = installIpc({ initial: { status: "none" }, stateRoot: install.stateRoot });
    const setting = ipc.handlers.get("desktop:session-timezone:setting");
    expect(await setting?.(ipc.event)).toEqual({
      status: "editable",
      mode: null,
      host: QYZYLORDA,
    });
    await chooseSessionTimezoneMode({ stateRoot: install.stateRoot, mode: "fixed", env: {} });
    expect(await setting?.(ipc.event)).toEqual({
      status: "editable",
      mode: "fixed",
      host: QYZYLORDA,
    });
    ipc.dispose();
  });
});
