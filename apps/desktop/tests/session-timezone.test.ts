import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml, stringify as toYaml } from "yaml";
import {
  adoptDeviceTimezoneAtStart,
  readSessionTimezonePin,
  sessionTimezonePinPath,
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

  it("never rewrites the stored zone when config embeds the athlete pin", async () => {
    const install = await createInstall(HARARE);
    const document = parseYaml(await install.read()) as Record<string, unknown>;
    document.session = {
      ...(document.session as Record<string, unknown>),
      timezonePinned: true,
    };
    await writeFile(install.configPath, toYaml(document), "utf8");
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

  it.each([false, "true", { pinned: true }])(
    "treats a non-true embedded marker as unpinned: %o",
    async (timezonePinned) => {
      const install = await createInstall(HARARE);
      const document = parseYaml(await install.read()) as Record<string, unknown>;
      document.session = {
        ...(document.session as Record<string, unknown>),
        timezonePinned,
      };
      await writeFile(install.configPath, toYaml(document), "utf8");

      await adoptDeviceTimezoneAtStart({
        configPath: install.configPath,
        stateRoot: install.stateRoot,
        env: {},
        hostTimezone: () => QYZYLORDA,
      });

      expect(await install.storedZone()).toEqual(QYZYLORDA);
    },
  );

  it("keeps a timezone pinned by the legacy sidecar", async () => {
    const install = await createInstall(HARARE);
    await writeFile(
      sessionTimezonePinPath(install.stateRoot),
      `${JSON.stringify({ schemaVersion: 1, pinned: true })}\n`,
      { mode: 0o600 },
    );
    const before = await install.read();
    await adoptDeviceTimezoneAtStart({
      configPath: install.configPath,
      stateRoot: install.stateRoot,
      env: {},
      hostTimezone: () => QYZYLORDA,
    });
    expect(await install.read()).toEqual(before);
    expect(await readSessionTimezonePin(install.stateRoot)).toEqual(true);
  });

  it("refuses to adopt while COACH_TZ owns the timezone", async () => {
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
    await adoptDeviceTimezoneAtStart({
      configPath: install.configPath,
      stateRoot: install.stateRoot,
      env: {},
      hostTimezone: () => QYZYLORDA,
    });
    expect(await install.storedZone()).toEqual(QYZYLORDA);
  });
});
