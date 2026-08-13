import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DESKTOP_RENDERER_URL } from "../src/main/constants.js";
import {
  createSessionTimezoneNoticeStore,
  installDesktopSessionTimezoneIpc,
} from "../src/main/session-timezone-ipc.js";
import {
  decideSessionTimezoneAtStart,
  readSessionTimezoneSource,
  reconcileSessionTimezoneAtStart,
  recordSessionTimezoneSource,
  sessionTimezoneSourcePath,
  type DesktopSessionTimezoneNotice,
} from "../src/main/session-timezone.js";

const HARARE = "Africa/Harare";
const QYZYLORDA = "Asia/Qyzylorda";
const LISBON = "Europe/Lisbon";

async function createInstall(storedTimezone: string): Promise<{
  readonly configPath: string;
  readonly stateRoot: string;
  readonly read: () => Promise<string>;
}> {
  const root = await mkdtemp(join(tmpdir(), "session-timezone-"));
  const configDirectory = join(root, "config");
  await mkdir(configDirectory, { recursive: true });
  const configPath = join(configDirectory, "config.yaml");
  await writeFile(
    configPath,
    ["data_source: store", "session:", `  timezone: ${storedTimezone}`, "  daily_reset_hour: 4", ""].join(
      "\n",
    ),
    "utf8",
  );
  const stateRoot = join(root, "preferences");
  await mkdir(stateRoot, { recursive: true });
  return { configPath, stateRoot, read: () => readFile(configPath, "utf8") };
}

function storedTimezoneOf(contents: string): string | undefined {
  const line = contents.split("\n").find((candidate) => candidate.trim().startsWith("timezone:"));
  return line?.split(":").slice(1).join(":").trim();
}

describe("desktop session timezone reconciliation", () => {
  it("adopts the host zone on the next start when the stored zone was auto-detected", async () => {
    const install = await createInstall(HARARE);
    await recordSessionTimezoneSource({ stateRoot: install.stateRoot, source: "auto" });

    const notice = await reconcileSessionTimezoneAtStart({
      configPath: install.configPath,
      stateRoot: install.stateRoot,
      env: {},
      hostTimezone: () => QYZYLORDA,
    });

    expect(notice).toEqual({ status: "none" });
    expect(storedTimezoneOf(await install.read())).toBe(QYZYLORDA);
    expect(await readSessionTimezoneSource(install.stateRoot)).toBe("auto");
  });

  it("keeps a zone the athlete set even when it equalled the host zone at the time", async () => {
    const install = await createInstall(LISBON);
    await recordSessionTimezoneSource({ stateRoot: install.stateRoot, source: "user" });
    const before = await install.read();

    expect(
      decideSessionTimezoneAtStart({
        environmentManaged: false,
        source: "user",
        stored: LISBON,
        host: LISBON,
      }),
    ).toEqual({ kind: "idle", reason: "user-set" });

    const notice = await reconcileSessionTimezoneAtStart({
      configPath: install.configPath,
      stateRoot: install.stateRoot,
      env: {},
      hostTimezone: () => QYZYLORDA,
    });

    expect(notice).toEqual({ status: "none" });
    expect(await install.read()).toBe(before);
    expect(storedTimezoneOf(await install.read())).toBe(LISBON);
  });

  it("asks once when there is no marker and never rewrites the config before the answer", async () => {
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
    expect(await readSessionTimezoneSource(install.stateRoot)).toBeUndefined();

    await recordSessionTimezoneSource({ stateRoot: install.stateRoot, source: "user" });
    expect(await readSessionTimezoneSource(install.stateRoot)).toBe("user");
    const afterKeeping = await reconcileSessionTimezoneAtStart({
      configPath: install.configPath,
      stateRoot: install.stateRoot,
      env: {},
      hostTimezone: () => QYZYLORDA,
    });
    expect(afterKeeping).toEqual({ status: "none" });
    expect(await install.read()).toBe(before);
  });

  it("stops asking once the athlete chooses the computer zone", async () => {
    const install = await createInstall(HARARE);

    expect(
      await reconcileSessionTimezoneAtStart({
        configPath: install.configPath,
        stateRoot: install.stateRoot,
        env: {},
        hostTimezone: () => QYZYLORDA,
      }),
    ).toEqual({ status: "reconcile", stored: HARARE, host: QYZYLORDA });

    await recordSessionTimezoneSource({ stateRoot: install.stateRoot, source: "auto" });
    const afterAdopting = await reconcileSessionTimezoneAtStart({
      configPath: install.configPath,
      stateRoot: install.stateRoot,
      env: {},
      hostTimezone: () => QYZYLORDA,
    });

    expect(afterAdopting).toEqual({ status: "none" });
    expect(storedTimezoneOf(await install.read())).toBe(QYZYLORDA);
    expect(
      await reconcileSessionTimezoneAtStart({
        configPath: install.configPath,
        stateRoot: install.stateRoot,
        env: {},
        hostTimezone: () => QYZYLORDA,
      }),
    ).toEqual({ status: "none" });
  });

  it("leaves everything alone when COACH_TZ owns the zone", async () => {
    const install = await createInstall(HARARE);
    const before = await install.read();

    const notice = await reconcileSessionTimezoneAtStart({
      configPath: install.configPath,
      stateRoot: install.stateRoot,
      env: { COACH_TZ: "Europe/Berlin" },
      hostTimezone: () => QYZYLORDA,
    });

    expect(notice).toEqual({ status: "none" });
    expect(await install.read()).toBe(before);
    expect(await readSessionTimezoneSource(install.stateRoot)).toBeUndefined();
    await expect(readFile(sessionTimezoneSourcePath(install.stateRoot), "utf8")).rejects.toThrow();
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
    expect(await readSessionTimezoneSource(install.stateRoot)).toBeUndefined();
  });

  it("never infers a source from a stored value that happens to match the host", async () => {
    expect(
      decideSessionTimezoneAtStart({ environmentManaged: false, stored: LISBON, host: LISBON }),
    ).toEqual({ kind: "idle", reason: "unchanged" });
    expect(
      decideSessionTimezoneAtStart({ environmentManaged: false, stored: HARARE, host: QYZYLORDA }),
    ).toEqual({ kind: "reconcile", stored: HARARE, host: QYZYLORDA });
    expect(
      decideSessionTimezoneAtStart({
        environmentManaged: true,
        source: "auto",
        stored: HARARE,
        host: QYZYLORDA,
      }),
    ).toEqual({ kind: "idle", reason: "environment-managed" });
  });
});

describe("desktop session timezone ipc", () => {
  function installIpc(initial: DesktopSessionTimezoneNotice, stateRoot: string) {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const notices = createSessionTimezoneNoticeStore();
    notices.set(initial);
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
      notices,
      record: (source) => recordSessionTimezoneSource({ stateRoot, source }),
    });
    const event = { sender: webContents, senderFrame: mainFrame } as never;
    return { handlers, dispose, event };
  }

  it("rejects an unrecognised source instead of writing a marker", async () => {
    const install = await createInstall(HARARE);
    const ipc = installIpc({ status: "reconcile", stored: HARARE, host: QYZYLORDA }, install.stateRoot);
    const record = ipc.handlers.get("desktop:session-timezone:record");
    expect(record).toBeDefined();
    await expect(
      Promise.resolve(record?.(ipc.event, "somewhere-else")),
    ).rejects.toBeInstanceOf(TypeError);
    expect(await readSessionTimezoneSource(install.stateRoot)).toBeUndefined();
    ipc.dispose();
  });
});
