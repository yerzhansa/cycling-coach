import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensurePrivateDirectory,
  nodeFileSystem,
  removeFileIfPresent,
} from "../src/filesystem/index.js";

describe("Node filesystem adapter", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function root(): Promise<string> {
    const value = await mkdtemp(join(tmpdir(), "filesystem-adapter-"));
    roots.push(value);
    return value;
  }

  it("exports the one atomic Node filesystem adapter", async () => {
    expect(typeof nodeFileSystem).toBe("function");
    const files = [
      resolve("packages/kernel-node/src/filesystem/index.ts"),
      resolve("packages/kernel-node/src/ingest/import-files.ts"),
    ];
    const definitions = (await Promise.all(files.map((path) => readFile(path, "utf8")))).flatMap(
      (source) => source.match(/function nodeFileSystem\s*\(/g) ?? [],
    );
    expect(definitions).toHaveLength(1);
  });

  it("publishes only after file sync and rename", async () => {
    const directory = await root();
    const target = join(directory, "nested", "state.json");
    await nodeFileSystem().writeFile(target, "first\n", { mode: 0o600 });
    expect(await readFile(target, "utf8")).toBe("first\n");
    expect(await readdir(join(directory, "nested"))).toEqual(["state.json"]);
    await writeFile(target, "old\n");
    await nodeFileSystem().writeFile(target, "replacement\n", { mode: 0o600 });
    expect(await readFile(target, "utf8")).toBe("replacement\n");
    if (process.platform !== "win32") {
      expect((await stat(target)).mode & 0o777).toBe(0o600);
    }
  });

  it.runIf(process.platform !== "win32")("secures private directories to mode 0700", async () => {
    const directory = join(await root(), "private");
    await ensurePrivateDirectory(directory);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    await ensurePrivateDirectory(directory);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
  });

  it.runIf(process.platform !== "win32")(
    "uses structural checks instead of POSIX mode changes on Windows",
    async () => {
      const directory = join(await root(), "private");
      await mkdir(directory, { mode: 0o755 });
      const before = (await stat(directory)).mode & 0o777;

      await ensurePrivateDirectory(directory, { platform: "win32" });

      expect((await stat(directory)).mode & 0o777).toBe(before);
    },
  );

  it("removes absent files idempotently and rethrows other errors", async () => {
    const directory = await root();
    const target = join(directory, "state.json");
    await removeFileIfPresent(target);
    await writeFile(target, "value");
    await removeFileIfPresent(target);
    await expect(readFile(target)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(removeFileIfPresent(directory)).rejects.not.toMatchObject({ code: "ENOENT" });
  });
});
