import {
  lstat as fileLstat,
  link as fileLink,
  mkdir as fileMkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm as fileRemove,
  writeFile as fileWrite,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import { migrateLegacyHomeUnderLock } from "../../../packages/coach/src/legacy-migration.js";
import {
  FIRST_RUN_CONFIG_DIRECTORY_MODE,
  FIRST_RUN_CONFIG_FILE_MODE,
  seedFirstRunConfig,
  type FirstRunConfigFileSystem,
} from "../src/main/first-run-config.js";

const roots: string[] = [];

const actualFileSystem: FirstRunConfigFileSystem = {
  async lstat(path) {
    await fileLstat(path);
  },
  async readFile(path, encoding) {
    return readFile(path, encoding);
  },
  async mkdir(path, options) {
    await fileMkdir(path, options);
  },
  async writeFile(path, contents, options) {
    await fileWrite(path, contents, options);
  },
  async link(temporaryPath, targetPath) {
    await fileLink(temporaryPath, targetPath);
  },
  async rm(path, options) {
    await fileRemove(path, options);
  },
};

async function temporaryHome(): Promise<string> {
  const root = await mkdtemp(join(await realpath(tmpdir()), "desktop-first-run-"));
  roots.push(root);
  return join(root, "private parent", "athlete home");
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => fileRemove(root, { recursive: true, force: true })),
  );
});

describe("desktop first-run configuration", () => {
  it("seeds a private parseable configuration when no legacy home exists", async () => {
    const home = await temporaryHome();
    const legacyHome = join(dirname(home), "absent legacy home");
    const timezone = vi.fn(() => "Asia/Almaty");

    await expect(
      seedFirstRunConfig({
        env: { ENDURAGENT_HOME: home, CYCLING_COACH_HOME: legacyHome },
        dependencies: { timezone },
      }),
    ).resolves.toBe("seeded");
    await expect(
      migrateLegacyHomeUnderLock({
        sourceRoot: legacyHome,
        targetRoot: home,
        action: { kind: "resume", isTTY: false },
      }),
    ).resolves.toMatchObject({ status: "not-needed" });

    const configDirectory = join(home, "config");
    const configPath = join(configDirectory, "config.yaml");
    for (const path of [dirname(home), home, configDirectory]) {
      expect((await fileLstat(path)).mode & 0o777).toBe(FIRST_RUN_CONFIG_DIRECTORY_MODE);
    }
    expect((await fileLstat(configPath)).mode & 0o777).toBe(FIRST_RUN_CONFIG_FILE_MODE);
    const contents = await readFile(configPath, "utf8");
    expect(contents).toBe(
      [
        "data_source: store",
        `data_dir: ${JSON.stringify(resolve(home))}`,
        "llm:",
        "  provider: anthropic",
        "  api_key: ''",
        "intervals:",
        "  api_key: ''",
        "  athlete_id: ''",
        "session:",
        "  timezone: Asia/Almaty",
        "",
      ].join("\n"),
    );
    const parsed = parseYaml(contents) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      data_source: "store",
      data_dir: resolve(home),
      llm: { provider: "anthropic", api_key: "" },
      intervals: { api_key: "", athlete_id: "" },
      session: { timezone: "Asia/Almaty" },
    });
    expect(timezone).toHaveBeenCalledOnce();
  });

  it("leaves an existing arbitrary configuration byte-identical without mutations", async () => {
    const home = await temporaryHome();
    const configDirectory = join(home, "config");
    const configPath = join(configDirectory, "config.yaml");
    const original = Buffer.from([0x3a, 0x00, 0xff, 0x0a]);
    await fileMkdir(configDirectory, { recursive: true, mode: 0o700 });
    await fileWrite(configPath, original, { mode: 0o600 });
    const fileSystem: FirstRunConfigFileSystem = {
      ...actualFileSystem,
      mkdir: vi.fn(actualFileSystem.mkdir),
      writeFile: vi.fn(actualFileSystem.writeFile),
      link: vi.fn(actualFileSystem.link),
      rm: vi.fn(actualFileSystem.rm),
    };

    await expect(
      seedFirstRunConfig({
        env: {
          ENDURAGENT_HOME: home,
          CYCLING_COACH_HOME: join(dirname(home), "absent legacy home"),
        },
        dependencies: { fileSystem, timezone: vi.fn(() => "UTC") },
      }),
    ).resolves.toBe("existing");

    expect(await readFile(configPath)).toEqual(original);
    expect(fileSystem.mkdir).not.toHaveBeenCalled();
    expect(fileSystem.writeFile).not.toHaveBeenCalled();
    expect(fileSystem.link).not.toHaveBeenCalled();
    expect(fileSystem.rm).not.toHaveBeenCalled();
  });

  it("defers configuration seeding and migrates a legacy configuration with its history", async () => {
    const home = await temporaryHome();
    const legacyHome = join(dirname(home), "legacy home");
    const legacyConfig = Buffer.from("llm:\n  provider: anthropic\nunknown: preserved\n");
    const legacyMemory = Buffer.from("durable athlete history\n");
    await fileMkdir(join(legacyHome, "memory"), { recursive: true, mode: 0o700 });
    await fileWrite(join(legacyHome, "config.yaml"), legacyConfig, { mode: 0o600 });
    await fileWrite(join(legacyHome, "memory", "MEMORY.md"), legacyMemory, { mode: 0o600 });

    await expect(
      seedFirstRunConfig({
        env: { ENDURAGENT_HOME: home, CYCLING_COACH_HOME: legacyHome },
        dependencies: { timezone: () => "UTC" },
      }),
    ).resolves.toBe("deferred");

    await expect(fileLstat(join(home, "config", "config.yaml"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    const result = await migrateLegacyHomeUnderLock({
      sourceRoot: legacyHome,
      targetRoot: home,
      action: { kind: "resume", isTTY: false },
    });

    expect(result).toMatchObject({ status: "done", completion: "complete" });
    const migratedConfig = await readFile(join(home, "config", "config.yaml"), "utf8");
    expect(migratedConfig).toContain("unknown: preserved");
    expect(parseYaml(migratedConfig)).toMatchObject({ data_dir: resolve(home) });
    expect(await readFile(join(home, "memory", "MEMORY.md"))).toEqual(legacyMemory);
    expect(await readFile(join(legacyHome, "config.yaml"))).toEqual(legacyConfig);
    expect(await readFile(join(legacyHome, "memory", "MEMORY.md"))).toEqual(legacyMemory);
  });

  it("seeds configuration and migrates history when the legacy home has no configuration", async () => {
    const home = await temporaryHome();
    const legacyHome = join(dirname(home), "legacy home");
    const legacyMemory = Buffer.from("durable athlete history\n");
    await fileMkdir(join(legacyHome, "memory"), { recursive: true, mode: 0o700 });
    await fileWrite(join(legacyHome, "memory", "MEMORY.md"), legacyMemory, { mode: 0o600 });

    await expect(
      seedFirstRunConfig({
        env: { ENDURAGENT_HOME: home, CYCLING_COACH_HOME: legacyHome },
        dependencies: { timezone: () => "UTC" },
      }),
    ).resolves.toBe("seeded");
    const seededConfig = await readFile(join(home, "config", "config.yaml"));

    const result = await migrateLegacyHomeUnderLock({
      sourceRoot: legacyHome,
      targetRoot: home,
      action: { kind: "resume", isTTY: false },
    });

    expect(result).toMatchObject({ status: "done" });
    expect(await readFile(join(home, "config", "config.yaml"))).toEqual(seededConfig);
    expect(await readFile(join(home, "memory", "MEMORY.md"))).toEqual(legacyMemory);
    expect(await readFile(join(legacyHome, "memory", "MEMORY.md"))).toEqual(legacyMemory);
  });

  it("does not seed or copy migration payload again after a successful upgrade", async () => {
    const home = await temporaryHome();
    const legacyHome = join(dirname(home), "legacy home");
    const env = { ENDURAGENT_HOME: home, CYCLING_COACH_HOME: legacyHome };
    await fileMkdir(join(legacyHome, "memory"), { recursive: true, mode: 0o700 });
    await fileWrite(join(legacyHome, "config.yaml"), "llm:\n  provider: anthropic\n", {
      mode: 0o600,
    });
    await fileWrite(join(legacyHome, "memory", "MEMORY.md"), "durable athlete history\n", {
      mode: 0o600,
    });
    await seedFirstRunConfig({ env, dependencies: { timezone: () => "UTC" } });
    const first = await migrateLegacyHomeUnderLock({
      sourceRoot: legacyHome,
      targetRoot: home,
      action: { kind: "resume", isTTY: false },
    });
    expect(first.status).toBe("done");
    if (first.status !== "done") throw new Error("expected completed migration");
    const configBefore = await readFile(join(home, "config", "config.yaml"));
    const memoryBefore = await readFile(join(home, "memory", "MEMORY.md"));
    const journalBefore = await readFile(first.journalPath);

    await expect(
      seedFirstRunConfig({ env, dependencies: { timezone: () => "UTC" } }),
    ).resolves.toBe("existing");
    const second = await migrateLegacyHomeUnderLock({
      sourceRoot: legacyHome,
      targetRoot: home,
      action: { kind: "resume", isTTY: false },
    });

    expect(second).toMatchObject({ status: "done", copiedIds: [], skipVerifiedIds: [] });
    expect(await readFile(join(home, "config", "config.yaml"))).toEqual(configBefore);
    expect(await readFile(join(home, "memory", "MEMORY.md"))).toEqual(memoryBefore);
    expect(await readFile(first.journalPath)).toEqual(journalBefore);
  });

  it("re-seeds a missing target configuration after migration completes", async () => {
    const home = await temporaryHome();
    const legacyHome = join(dirname(home), "legacy home");
    const env = { ENDURAGENT_HOME: home, CYCLING_COACH_HOME: legacyHome };
    await fileMkdir(join(legacyHome, "memory"), { recursive: true, mode: 0o700 });
    await fileWrite(
      join(legacyHome, "config.yaml"),
      "llm:\n  provider: anthropic\nunknown: preserved\n",
      { mode: 0o600 },
    );
    await fileWrite(join(legacyHome, "memory", "MEMORY.md"), "durable athlete history\n", {
      mode: 0o600,
    });
    await expect(seedFirstRunConfig({ env })).resolves.toBe("deferred");
    await expect(
      migrateLegacyHomeUnderLock({
        sourceRoot: legacyHome,
        targetRoot: home,
        action: { kind: "resume", isTTY: false },
      }),
    ).resolves.toMatchObject({ status: "done" });
    await fileRemove(join(home, "config", "config.yaml"), { force: true });

    await expect(
      seedFirstRunConfig({ env, dependencies: { timezone: () => "UTC" } }),
    ).resolves.toBe("seeded");
    await expect(
      migrateLegacyHomeUnderLock({
        sourceRoot: legacyHome,
        targetRoot: home,
        action: { kind: "resume", isTTY: false },
      }),
    ).resolves.toMatchObject({ status: "done", copiedIds: [], skipVerifiedIds: [] });

    expect(parseYaml(await readFile(join(home, "config", "config.yaml"), "utf8"))).toMatchObject({
      data_source: "store",
      data_dir: resolve(home),
      session: { timezone: "UTC" },
    });
    expect(await readFile(join(home, "memory", "MEMORY.md"), "utf8")).toBe(
      "durable athlete history\n",
    );
  });

  it("cleans up a failed atomic write before exposing the target", async () => {
    const home = await temporaryHome();
    const configPath = join(home, "config", "config.yaml");
    let temporaryPath = "";
    const link = vi.fn(actualFileSystem.link);
    const fileSystem: FirstRunConfigFileSystem = {
      ...actualFileSystem,
      async writeFile(path) {
        temporaryPath = path;
        await fileWrite(path, "partial", { flag: "wx", mode: 0o600 });
        throw new Error("synthetic write failure");
      },
      link,
    };

    await expect(
      seedFirstRunConfig({
        env: {
          ENDURAGENT_HOME: home,
          CYCLING_COACH_HOME: join(dirname(home), "absent legacy home"),
        },
        dependencies: { fileSystem, timezone: () => "UTC", createId: () => "atomic-seam" },
      }),
    ).rejects.toThrow("synthetic write failure");

    expect(dirname(temporaryPath)).toBe(dirname(configPath));
    expect(temporaryPath).toBe(join(dirname(configPath), ".config.atomic-seam.tmp"));
    await expect(fileLstat(configPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(dirname(configPath))).toEqual([]);
    expect(link).not.toHaveBeenCalled();
  });

  it("preserves a configuration published concurrently with the seed", async () => {
    const home = await temporaryHome();
    const configPath = join(home, "config", "config.yaml");
    const concurrent = Buffer.from("concurrent invalid bytes\u0000\n");
    const fileSystem: FirstRunConfigFileSystem = {
      ...actualFileSystem,
      async link(temporaryPath, targetPath) {
        await fileWrite(targetPath, concurrent, { flag: "wx", mode: 0o600 });
        await fileLink(temporaryPath, targetPath);
      },
    };

    await expect(
      seedFirstRunConfig({
        env: {
          ENDURAGENT_HOME: home,
          CYCLING_COACH_HOME: join(dirname(home), "absent legacy home"),
        },
        dependencies: { fileSystem, timezone: () => "UTC" },
      }),
    ).resolves.toBe("existing");

    expect(await readFile(configPath)).toEqual(concurrent);
    expect(await readdir(dirname(configPath))).toEqual(["config.yaml"]);
  });

  it("falls back to UTC when the timezone provider is unavailable", async () => {
    const home = await temporaryHome();
    await seedFirstRunConfig({
      env: {
        ENDURAGENT_HOME: home,
        CYCLING_COACH_HOME: join(dirname(home), "absent legacy home"),
      },
      dependencies: { timezone: () => undefined },
    });
    const parsed = parseYaml(await readFile(join(home, "config", "config.yaml"), "utf8")) as {
      session: { timezone: string };
    };
    expect(parsed.session.timezone).toBe("UTC");
  });

  it("integrates the seed before constructing the daemon supervisor", async () => {
    const source = await readFile(resolve(import.meta.dirname, "../src/main/index.ts"), "utf8");
    const seedCall = source.indexOf("await seedFirstRunConfig({ env: environment });");
    const supervisorConstruction = source.indexOf("new DesktopDaemonSupervisor(");
    expect(seedCall).toBeGreaterThan(-1);
    expect(supervisorConstruction).toBeGreaterThan(seedCall);
    expect(source).toContain('process.stderr.write("desktop-first-run-config-failure seed\\n");');
  });
});
