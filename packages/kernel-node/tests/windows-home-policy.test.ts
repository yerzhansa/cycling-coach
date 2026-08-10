import { lstat, mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareAthleteHome } from "../src/home/prepare-athlete-home.js";
import { resolveAthleteHome } from "../src/home/resolve-athlete-home.js";
import {
  WindowsAthleteHomePolicyError,
  ensureWindowsPrivateDirectory,
} from "../src/home/windows-home-policy.js";

const roots: string[] = [];

async function freshPath(): Promise<string> {
  const base = await mkdtemp(join(await realpath(tmpdir()), "windows-home-policy-"));
  roots.push(base);
  return join(base, "athlete");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Windows athlete home policy", () => {
  it("creates and binds the fixed athlete-home layout without inspecting POSIX modes", async () => {
    const root = await freshPath();

    const home = await prepareAthleteHome(resolveAthleteHome({ ENDURAGENT_HOME: root }), {
      platform: "win32",
    });

    expect(home).toEqual({
      root: await realpath(root),
      storeDir: join(await realpath(root), "store"),
      archiveDir: join(await realpath(root), "archive"),
      configDir: join(await realpath(root), "config"),
    });
    expect(Object.isFrozen(home)).toBe(true);
    for (const path of [home.root, home.storeDir, home.archiveDir, home.configDir]) {
      expect((await lstat(path)).isDirectory()).toBe(true);
    }
  });

  it.runIf(process.platform !== "win32")(
    "leaves existing POSIX mode bits untouched under injected Windows semantics",
    async () => {
      const root = await freshPath();
      await mkdir(root, { mode: 0o755 });
      for (const name of ["store", "archive", "config"]) {
        await mkdir(join(root, name), { mode: 0o755 });
      }
      const before = await Promise.all(
        [root, join(root, "store"), join(root, "archive"), join(root, "config")].map(
          async (path) => (await stat(path)).mode & 0o777,
        ),
      );

      const home = await prepareAthleteHome(resolveAthleteHome({ ENDURAGENT_HOME: root }), {
        platform: "win32",
      });

      const after = await Promise.all(
        [home.root, home.storeDir, home.archiveDir, home.configDir].map(
          async (path) => (await stat(path)).mode & 0o777,
        ),
      );
      expect(after).toEqual(before);
    },
  );

  it("allows concurrent Windows first-start preparation to converge", async () => {
    const root = await freshPath();
    const unresolved = resolveAthleteHome({ ENDURAGENT_HOME: root });

    const homes = await Promise.all(
      Array.from({ length: 8 }, async () => prepareAthleteHome(unresolved, { platform: "win32" })),
    );

    expect(homes).toHaveLength(8);
    expect(homes.every((home) => home.root === homes[0]!.root)).toBe(true);
  });

  it.each(["root", "store"] as const)(
    "rejects a link or reparse-shaped %s entry",
    async (entry) => {
      const root = await freshPath();
      const outside = join(root, "..", `outside-${entry}`);
      await mkdir(outside);
      if (entry === "root") {
        await symlink(outside, root, process.platform === "win32" ? "junction" : "dir");
      } else {
        await mkdir(root);
        await symlink(
          outside,
          join(root, entry),
          process.platform === "win32" ? "junction" : "dir",
        );
      }

      await expect(
        prepareAthleteHome(resolveAthleteHome({ ENDURAGENT_HOME: root }), {
          platform: "win32",
        }),
      ).rejects.toMatchObject({ category: "link-reparse-shaped" });
    },
  );

  it.each(["root", "store"] as const)("rejects the wrong %s entry type", async (entry) => {
    const root = await freshPath();
    if (entry === "root") {
      await writeFile(root, "not-a-directory");
    } else {
      await mkdir(root);
      await writeFile(join(root, entry), "not-a-directory");
    }

    await expect(
      prepareAthleteHome(resolveAthleteHome({ ENDURAGENT_HOME: root }), {
        platform: "win32",
      }),
    ).rejects.toMatchObject({ category: "entry-type" });
  });

  it("rejects a filesystem root as non-ordinary", async () => {
    await expect(
      ensureWindowsPrivateDirectory(parse(await realpath(tmpdir())).root),
    ).rejects.toMatchObject({ stage: "directory-bind", category: "corruption" });
  });

  it("returns path-free, cause-free diagnostics for Node failures", async () => {
    const base = await freshPath();
    const privateMarker = "Private Athlete";
    const root = `${base}-${privateMarker}\0`;
    const failure = await prepareAthleteHome(resolveAthleteHome({ ENDURAGENT_HOME: root }), {
      platform: "win32",
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(WindowsAthleteHomePolicyError);
    expect(failure).toMatchObject({
      name: "WindowsAthleteHomePolicyError",
      message: "Windows athlete home policy failed",
      stage: "root-entry",
      category: "io-failure",
    });
    expect(failure).not.toHaveProperty("path");
    expect(failure).not.toHaveProperty("cause");
    expect(String(failure)).not.toContain(privateMarker);
    expect(JSON.stringify(failure)).not.toContain(privateMarker);
  });

  it.runIf(process.platform !== "win32")(
    "rejects a link-shaped reusable private directory without changing its target",
    async () => {
      const path = await freshPath();
      const target = join(path, "..", "private-target");
      await mkdir(target, { mode: 0o755 });
      const before = (await stat(target)).mode & 0o777;
      await symlink(target, path, "dir");

      await expect(ensureWindowsPrivateDirectory(path)).rejects.toMatchObject({
        stage: "directory-entry",
        category: "link-reparse-shaped",
      });
      expect((await stat(target)).mode & 0o777).toBe(before);
    },
  );
});
