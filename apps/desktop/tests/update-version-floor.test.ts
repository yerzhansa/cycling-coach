import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDesktopUpdateVersionFloor,
  DESKTOP_UPDATE_VERSION_FLOOR_DIRECTORY_MODE,
  DESKTOP_UPDATE_VERSION_FLOOR_FILE_MODE,
  DESKTOP_UPDATE_VERSION_FLOOR_FILE_NAME,
} from "../src/main/update-version-floor.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("desktop update version floor", () => {
  it("survives a restart and never falls below the highest version run", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "desktop-update-version-floor-"));
    temporaryRoots.push(temporaryRoot);
    const root = join(temporaryRoot, "desktop-preferences-v1");
    const firstProcess = createDesktopUpdateVersionFloor({ root });

    await expect(firstProcess.recordRunningVersion("2.3.4")).resolves.toEqual({
      status: "ready",
      version: "2.3.4",
    });

    const restartedProcess = createDesktopUpdateVersionFloor({ root });
    await expect(restartedProcess.recordRunningVersion("1.9.9")).resolves.toEqual({
      status: "ready",
      version: "2.3.4",
    });
  });

  it("self-heals a corrupt record with the running version and survives another restart", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "desktop-update-version-floor-"));
    temporaryRoots.push(temporaryRoot);
    const root = join(temporaryRoot, "desktop-preferences-v1");
    const target = join(root, DESKTOP_UPDATE_VERSION_FLOOR_FILE_NAME);
    const initial = createDesktopUpdateVersionFloor({ root });
    await initial.recordRunningVersion("2.3.4");
    await writeFile(target, "not-json\n");
    const log = vi.fn();

    const recovered = createDesktopUpdateVersionFloor({ root, log });
    await expect(recovered.recordRunningVersion("1.2.3")).resolves.toEqual({
      status: "ready",
      version: "1.2.3",
    });

    expect(log).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith("desktop-update-version-floor-recovered");
    await expect(readFile(target, "utf8")).resolves.toBe(
      `${JSON.stringify({ schemaVersion: 1, version: "1.2.3" })}\n`,
    );
    expect((await lstat(root)).mode & 0o777).toBe(DESKTOP_UPDATE_VERSION_FLOOR_DIRECTORY_MODE);
    expect((await lstat(target)).mode & 0o777).toBe(DESKTOP_UPDATE_VERSION_FLOOR_FILE_MODE);

    const restarted = createDesktopUpdateVersionFloor({ root });
    await expect(restarted.recordRunningVersion("1.0.0")).resolves.toEqual({
      status: "ready",
      version: "1.2.3",
    });
  });

  it("accepts a valid future-schema floor with additional fields", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "desktop-update-version-floor-"));
    temporaryRoots.push(temporaryRoot);
    const root = join(temporaryRoot, "desktop-preferences-v1");
    const target = join(root, DESKTOP_UPDATE_VERSION_FLOOR_FILE_NAME);
    await mkdir(root, { mode: DESKTOP_UPDATE_VERSION_FLOOR_DIRECTORY_MODE });
    await chmod(root, DESKTOP_UPDATE_VERSION_FLOOR_DIRECTORY_MODE);
    const contents = `${JSON.stringify({
      schemaVersion: 2,
      version: "3.4.5",
      additionalField: true,
    })}\n`;
    await writeFile(target, contents, { mode: DESKTOP_UPDATE_VERSION_FLOOR_FILE_MODE });
    await chmod(target, DESKTOP_UPDATE_VERSION_FLOOR_FILE_MODE);
    const log = vi.fn();

    const floor = createDesktopUpdateVersionFloor({ root, log });
    await expect(floor.recordRunningVersion("2.0.0")).resolves.toEqual({
      status: "ready",
      version: "3.4.5",
    });

    await expect(readFile(target, "utf8")).resolves.toBe(contents);
    expect(log).not.toHaveBeenCalled();
  });

  it("self-heals a future-schema record whose version is invalid", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "desktop-update-version-floor-"));
    temporaryRoots.push(temporaryRoot);
    const root = join(temporaryRoot, "desktop-preferences-v1");
    const target = join(root, DESKTOP_UPDATE_VERSION_FLOOR_FILE_NAME);
    await mkdir(root, { mode: DESKTOP_UPDATE_VERSION_FLOOR_DIRECTORY_MODE });
    await chmod(root, DESKTOP_UPDATE_VERSION_FLOOR_DIRECTORY_MODE);
    await writeFile(target, JSON.stringify({ schemaVersion: 2, version: "invalid" }), {
      mode: DESKTOP_UPDATE_VERSION_FLOOR_FILE_MODE,
    });
    await chmod(target, DESKTOP_UPDATE_VERSION_FLOOR_FILE_MODE);
    const log = vi.fn();

    const floor = createDesktopUpdateVersionFloor({ root, log });
    await expect(floor.recordRunningVersion("1.2.3")).resolves.toEqual({
      status: "ready",
      version: "1.2.3",
    });
    expect(log).toHaveBeenCalledWith("desktop-update-version-floor-recovered");
  });
});
