import { lstat, mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareAthleteHome } from "../src/home/prepare-athlete-home.js";
import { resolveAthleteHome } from "../src/home/resolve-athlete-home.js";

const roots: string[] = [];

async function freshPath(): Promise<string> {
  const base = await mkdtemp(join(await realpath(tmpdir()), "prepare-athlete-home-"));
  roots.push(base);
  return join(base, "athlete");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("prepareAthleteHome", () => {
  it("creates a fresh private athlete home and returns its frozen physical identity", async () => {
    const root = await freshPath();

    const home = await prepareAthleteHome(resolveAthleteHome({ ENDURAGENT_HOME: root }));

    expect(home).toEqual({
      root: await realpath(root),
      storeDir: join(await realpath(root), "store"),
      archiveDir: join(await realpath(root), "archive"),
      configDir: join(await realpath(root), "config"),
    });
    expect(Object.isFrozen(home)).toBe(true);
    for (const path of [home.root, home.storeDir, home.archiveDir, home.configDir]) {
      expect((await lstat(path)).isDirectory()).toBe(true);
      expect(await realpath(path)).toBe(path);
      if (process.platform !== "win32") {
        expect((await stat(path)).mode & 0o777).toBe(0o700);
      }
    }
  });

  it("allows concurrent first-start preparation to converge on one home", async () => {
    const root = await freshPath();
    const unresolved = resolveAthleteHome({ ENDURAGENT_HOME: root });

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, async () => prepareAthleteHome(unresolved)),
    );

    const homes = results.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    expect(homes).toHaveLength(8);
    expect(homes.every((home) => home.root === homes[0]!.root)).toBe(true);
  });

  it.runIf(process.platform !== "win32")(
    "converges a root symlink and its physical path on one athlete-home identity",
    async () => {
      const alias = await freshPath();
      const physicalRoot = join(alias, "..", "physical-athlete");
      await mkdir(physicalRoot);
      await symlink(physicalRoot, alias, "dir");

      const throughAlias = await prepareAthleteHome(resolveAthleteHome({ ENDURAGENT_HOME: alias }));
      const throughPhysicalPath = await prepareAthleteHome(
        resolveAthleteHome({ ENDURAGENT_HOME: physicalRoot }),
      );

      expect(throughAlias).toEqual(throughPhysicalPath);
      expect(throughAlias.root).toBe(await realpath(physicalRoot));
    },
  );

  it("rejects a child-directory symlink instead of following it", async () => {
    const root = await freshPath();
    const outside = join(root, "..", "outside-store");
    await mkdir(root);
    await mkdir(outside);
    await symlink(outside, join(root, "store"), process.platform === "win32" ? "junction" : "dir");

    const preparation = prepareAthleteHome(resolveAthleteHome({ ENDURAGENT_HOME: root }));
    if (process.platform === "win32") {
      await expect(preparation).rejects.toMatchObject({
        stage: "child-entry",
        category: "link-reparse-shaped",
      });
    } else {
      await expect(preparation).rejects.toThrow(/store.*symbolic link/i);
    }
  });

  it.each(["root", "store"] as const)(
    "rejects a %s file where a directory is required",
    async (entry) => {
      const root = await freshPath();
      if (entry === "root") {
        await writeFile(root, "not-a-directory");
      } else {
        await mkdir(root);
        await writeFile(join(root, entry), "not-a-directory");
      }

      await expect(
        prepareAthleteHome(resolveAthleteHome({ ENDURAGENT_HOME: root })),
      ).rejects.toThrow();
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects a root symlink to a file without changing the target mode",
    async () => {
      const root = await freshPath();
      const target = join(root, "..", "athlete-file");
      await writeFile(target, "not-a-directory", { mode: 0o600 });
      await symlink(target, root, "file");

      const preparation = prepareAthleteHome(resolveAthleteHome({ ENDURAGENT_HOME: root }));
      await expect(preparation).rejects.toThrow(/root.*directory/i);
      expect((await stat(target)).mode & 0o777).toBe(0o600);
    },
  );

  it("rejects an athlete-home value whose child paths do not use the fixed layout", async () => {
    const root = await freshPath();
    const home = resolveAthleteHome({ ENDURAGENT_HOME: root });

    const preparation = prepareAthleteHome({
      ...home,
      archiveDir: join(root, "..", "outside-archive"),
    });
    if (process.platform === "win32") {
      await expect(preparation).rejects.toMatchObject({
        stage: "layout",
        category: "corruption",
      });
    } else {
      await expect(preparation).rejects.toThrow(/fixed child layout/i);
    }
  });

  it("rejects a relative athlete-home root before creating it", async () => {
    const relativeRoot = `relative-athlete-home-${process.pid}`;
    roots.push(resolvePath(relativeRoot));

    const preparation = prepareAthleteHome(
      resolveAthleteHome({ ENDURAGENT_HOME: relativeRoot }),
    );
    if (process.platform === "win32") {
      await expect(preparation).rejects.toMatchObject({
        stage: "layout",
        category: "corruption",
      });
    } else {
      await expect(preparation).rejects.toThrow(/absolute/i);
    }
  });

  it("rejects the filesystem root before changing its permissions", async () => {
    const root = resolvePath("/");

    const preparation = prepareAthleteHome(resolveAthleteHome({ ENDURAGENT_HOME: root }));
    if (process.platform === "win32") {
      await expect(preparation).rejects.toMatchObject({
        stage: "root-bind",
        category: "corruption",
      });
    } else {
      await expect(preparation).rejects.toThrow(/filesystem root/i);
    }
  });
});
