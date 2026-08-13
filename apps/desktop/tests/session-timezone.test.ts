import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { DESKTOP_RENDERER_URL } from "../src/main/constants.js";
import { installDesktopSessionTimezoneIpc } from "../src/main/session-timezone-ipc.js";
import {
  adoptDeviceTimezoneAtStart,
  pinSessionTimezone,
  readSessionTimezonePin,
  sessionTimezonePinPath,
  SESSION_TIMEZONE_PIN_FILE_NAME,
} from "../src/main/session-timezone.js";

const HARARE = "Africa/Harare";
const QYZYLORDA = "Asia/Qyzylorda";

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

describe("desktop session timezone adoption", () => {
  it("rewrites the stored zone to the device zone when nothing is pinned", async () => {
    const install = await createInstall(HARARE);
    await adoptDeviceTimezoneAtStart({
      configPath: install.configPath,
      stateRoot: install.stateRoot,
      env: {},
      hostTimezone: () => QYZYLORDA,
    });
    expect(await install.storedZone()).toEqual(QYZYLORDA);
    const document = parseYaml(await install.read()) as {
      readonly session?: { readonly daily_reset_hour?: unknown };
    };
    expect(document.session?.daily_reset_hour).toEqual(4);
    expect(await readSessionTimezonePin(install.stateRoot)).toEqual(false);
  });

  it("leaves the config bytes untouched when the stored zone already equals the device zone", async () => {
    const install = await createInstall(QYZYLORDA);
    const before = await install.read();
    await adoptDeviceTimezoneAtStart({
      configPath: install.configPath,
      stateRoot: install.stateRoot,
      env: {},
      hostTimezone: () => QYZYLORDA,
    });
    expect(await install.read()).toEqual(before);
  });

  it("never rewrites the stored zone once the athlete pinned one", async () => {
    const install = await createInstall(HARARE);
    expect(await pinSessionTimezone({ stateRoot: install.stateRoot, env: {} })).toEqual(true);
    const before = await install.read();
    await adoptDeviceTimezoneAtStart({
      configPath: install.configPath,
      stateRoot: install.stateRoot,
      env: {},
      hostTimezone: () => QYZYLORDA,
    });
    expect(await install.read()).toEqual(before);
    expect(await install.storedZone()).toEqual(HARARE);
  });

  it("writes the pin marker as one durable line of pinned json", async () => {
    const install = await createInstall(HARARE);
    expect(await pinSessionTimezone({ stateRoot: install.stateRoot, env: {} })).toEqual(true);
    expect(await readFile(sessionTimezonePinPath(install.stateRoot), "utf8")).toEqual(
      '{"schemaVersion":1,"pinned":true}\n',
    );
    expect(sessionTimezonePinPath(install.stateRoot)).toEqual(
      join(install.stateRoot, SESSION_TIMEZONE_PIN_FILE_NAME),
    );
    expect(await readSessionTimezonePin(install.stateRoot)).toEqual(true);
  });

  it("refuses to adopt or to pin while COACH_TZ owns the timezone", async () => {
    const install = await createInstall(HARARE);
    const before = await install.read();
    const env = { COACH_TZ: QYZYLORDA };
    await adoptDeviceTimezoneAtStart({
      configPath: install.configPath,
      stateRoot: install.stateRoot,
      env,
      hostTimezone: () => QYZYLORDA,
    });
    expect(await install.read()).toEqual(before);
    expect(await pinSessionTimezone({ stateRoot: install.stateRoot, env })).toEqual(false);
    expect(await readSessionTimezonePin(install.stateRoot)).toEqual(false);
    await expect(readFile(sessionTimezonePinPath(install.stateRoot), "utf8")).rejects.toThrow();
  });

  it("leaves the config alone when the device reports no timezone", async () => {
    const install = await createInstall(HARARE);
    const before = await install.read();
    await adoptDeviceTimezoneAtStart({
      configPath: install.configPath,
      stateRoot: install.stateRoot,
      env: {},
      hostTimezone: () => undefined,
    });
    expect(await install.read()).toEqual(before);
  });

  it("leaves the config alone when the device reports an unusable timezone", async () => {
    const install = await createInstall(HARARE);
    const before = await install.read();
    await adoptDeviceTimezoneAtStart({
      configPath: install.configPath,
      stateRoot: install.stateRoot,
      env: {},
      hostTimezone: () => "Somewhere/Else",
    });
    expect(await install.read()).toEqual(before);
  });

  it("adopts the device zone when the config has no session block yet", async () => {
    const install = await createInstall(HARARE);
    await writeFile(install.configPath, "data_source: store\n", "utf8");
    await adoptDeviceTimezoneAtStart({
      configPath: install.configPath,
      stateRoot: install.stateRoot,
      env: {},
      hostTimezone: () => QYZYLORDA,
    });
    expect(await install.storedZone()).toEqual(QYZYLORDA);
  });

  it("treats an unreadable pin marker as no pin at all", async () => {
    const install = await createInstall(HARARE);
    await writeFile(sessionTimezonePinPath(install.stateRoot), "not json", { mode: 0o600 });
    expect(await readSessionTimezonePin(install.stateRoot)).toEqual(false);
    await adoptDeviceTimezoneAtStart({
      configPath: install.configPath,
      stateRoot: install.stateRoot,
      env: {},
      hostTimezone: () => QYZYLORDA,
    });
    expect(await install.storedZone()).toEqual(QYZYLORDA);
  });

  it("ignores a marker that never claimed a pin", async () => {
    const install = await createInstall(HARARE);
    await writeFile(
      sessionTimezonePinPath(install.stateRoot),
      `${JSON.stringify({ schemaVersion: 1, pinned: false })}\n`,
      { mode: 0o600 },
    );
    expect(await readSessionTimezonePin(install.stateRoot)).toEqual(false);
  });
});

describe("desktop session timezone ipc", () => {
  function installIpc(pin: () => Promise<boolean>) {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const mainFrame = { url: DESKTOP_RENDERER_URL };
    const webContents = { isDestroyed: () => false, mainFrame };
    const window = { isDestroyed: () => false, webContents } as never;
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
      pin,
    });
    const event = { sender: webContents, senderFrame: mainFrame } as never;
    return { handlers, dispose, event };
  }

  it("pins on the single trusted channel and reports the write outcome", async () => {
    const install = await createInstall(HARARE);
    const ipc = installIpc(() => pinSessionTimezone({ stateRoot: install.stateRoot, env: {} }));
    const handler = ipc.handlers.get("desktop:session-timezone:pin");
    expect(handler).toBeDefined();
    expect(await handler?.(ipc.event)).toEqual(true);
    expect(await readSessionTimezonePin(install.stateRoot)).toEqual(true);
    ipc.dispose();
    expect(ipc.handlers.get("desktop:session-timezone:pin")).toBeUndefined();
  });

  it("refuses a pin request that carries arguments", async () => {
    let calls = 0;
    const ipc = installIpc(async () => {
      calls += 1;
      return true;
    });
    const handler = ipc.handlers.get("desktop:session-timezone:pin");
    await expect(Promise.resolve(handler?.(ipc.event, "follow"))).rejects.toBeInstanceOf(TypeError);
    expect(calls).toEqual(0);
    ipc.dispose();
  });

  it("refuses a pin request from an untrusted frame", async () => {
    let calls = 0;
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const dispose = installDesktopSessionTimezoneIpc({
      ipcMain: {
        handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
          handlers.set(channel, handler);
        },
        removeHandler: (channel: string) => {
          handlers.delete(channel);
        },
      } as never,
      currentWindow: () => undefined,
      pin: async () => {
        calls += 1;
        return true;
      },
    });
    const hostileFrame = { url: "https://example.test/" };
    const hostileContents = { isDestroyed: () => false, mainFrame: hostileFrame };
    const event = { sender: hostileContents, senderFrame: hostileFrame } as never;
    const handler = handlers.get("desktop:session-timezone:pin");
    await expect(Promise.resolve(handler?.(event))).rejects.toThrow();
    expect(calls).toEqual(0);
    dispose();
  });
});
