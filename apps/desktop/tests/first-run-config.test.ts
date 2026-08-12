import {
  chmod,
  lstat as fileLstat,
  link as fileLink,
  mkdir as fileMkdir,
  mkdtemp,
  open as fileOpen,
  readFile,
  realpath,
  readdir,
  rm as fileRemove,
  writeFile as fileWrite,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { WindowsPrivatePathPolicyError } from "@enduragent/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
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
  it("seeds a private parseable configuration", async () => {
    const home = await temporaryHome();
    const timezone = vi.fn(() => "Asia/Almaty");

    await expect(
      seedFirstRunConfig({ env: { ENDURAGENT_HOME: home }, dependencies: { timezone } }),
    ).resolves.toBe("seeded");

    const configDirectory = join(home, "config");
    const configPath = join(configDirectory, "config.yaml");
    if (process.platform === "win32") {
      expect((await fileLstat(configPath)).nlink).toBe(1);
    } else {
      for (const path of [dirname(home), home, configDirectory]) {
        expect((await fileLstat(path)).mode & 0o777).toBe(FIRST_RUN_CONFIG_DIRECTORY_MODE);
      }
      expect((await fileLstat(configPath)).mode & 0o777).toBe(FIRST_RUN_CONFIG_FILE_MODE);
    }
    const contents = await readFile(configPath, "utf8");
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

  it("does not inspect or copy an old npm home", async () => {
    const home = await temporaryHome();
    const legacyHome = join(dirname(dirname(home)), "legacy npm home");
    const legacyConfig = "llm:\n  provider: openai\ntelegram:\n  bot_token: old-secret\n";
    const legacyMemory = "old athlete memory\n";
    await fileMkdir(join(legacyHome, "memory"), { recursive: true, mode: 0o700 });
    await fileWrite(join(legacyHome, "config.yaml"), legacyConfig, { mode: 0o600 });
    await fileWrite(join(legacyHome, "memory", "MEMORY.md"), legacyMemory, { mode: 0o600 });
    await expect(
      seedFirstRunConfig({
        env: { ENDURAGENT_HOME: home, CYCLING_COACH_HOME: legacyHome },
        dependencies: { timezone: () => "UTC" },
      }),
    ).resolves.toBe("seeded");

    const seeded = parseYaml(await readFile(join(home, "config", "config.yaml"), "utf8")) as {
      llm: { provider: string; api_key: string };
      telegram?: unknown;
    };
    expect(seeded.llm).toEqual({ provider: "anthropic", api_key: "" });
    expect(seeded.telegram).toBeUndefined();
    expect(await readFile(join(legacyHome, "config.yaml"), "utf8")).toBe(legacyConfig);
    expect(await readFile(join(legacyHome, "memory", "MEMORY.md"), "utf8")).toBe(legacyMemory);
  });

  it("leaves an existing arbitrary configuration byte-identical", async () => {
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
      seedFirstRunConfig({ env: { ENDURAGENT_HOME: home }, dependencies: { fileSystem } }),
    ).resolves.toBe("existing");
    expect(await readFile(configPath)).toEqual(original);
    expect(fileSystem.mkdir).not.toHaveBeenCalled();
    expect(fileSystem.writeFile).not.toHaveBeenCalled();
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
        env: { ENDURAGENT_HOME: home },
        dependencies: { fileSystem, timezone: () => "UTC", createId: () => "atomic-seam" },
      }),
    ).rejects.toThrow("synthetic write failure");
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
      seedFirstRunConfig({ env: { ENDURAGENT_HOME: home }, dependencies: { fileSystem } }),
    ).resolves.toBe("existing");
    expect(await readFile(configPath)).toEqual(concurrent);
    expect(await readdir(dirname(configPath))).toEqual(["config.yaml"]);
  });

  it("falls back to UTC when the timezone provider is unavailable", async () => {
    const home = await temporaryHome();
    await seedFirstRunConfig({
      env: { ENDURAGENT_HOME: home },
      dependencies: { timezone: () => undefined },
    });
    const parsed = parseYaml(await readFile(join(home, "config", "config.yaml"), "utf8")) as {
      session: { timezone: string };
    };
    expect(parsed.session.timezone).toBe("UTC");
  });

  it("seeds and reopens a Windows configuration without POSIX mode assertions", async () => {
    const home = await temporaryHome();
    const timezone = vi.fn(() => "Asia/Almaty");

    await expect(
      seedFirstRunConfig({
        env: { ENDURAGENT_HOME: home },
        platform: "win32",
        dependencies: { timezone, createId: () => "windows-seed" },
      }),
    ).resolves.toBe("seeded");

    const configDirectory = join(home, "config");
    const configPath = join(configDirectory, "config.yaml");
    expect((await fileLstat(configPath)).nlink).toBe(1);
    expect(parseYaml(await readFile(configPath, "utf8"))).toMatchObject({
      data_dir: resolve(home),
      session: { timezone: "Asia/Almaty" },
    });
    await chmod(configDirectory, 0o755);
    await chmod(configPath, 0o644);
    const existingTimezone = vi.fn(() => "UTC");
    await expect(
      seedFirstRunConfig({
        env: { ENDURAGENT_HOME: home },
        platform: "win32",
        dependencies: { timezone: existingTimezone },
      }),
    ).resolves.toBe("existing");
    expect(existingTimezone).not.toHaveBeenCalled();
  });

  it("surfaces a path-free Windows first-run file-flush failure", async () => {
    const home = await temporaryHome();
    let observed: unknown;

    try {
      await seedFirstRunConfig({
        env: { ENDURAGENT_HOME: home },
        platform: "win32",
        dependencies: {
          timezone: () => "UTC",
          createId: () => "windows-flush-failure",
          openFile: (async (path, flags, mode) => {
            const handle = await fileOpen(path, flags, mode);
            return new Proxy(handle, {
              get(target, property) {
                if (property === "sync") {
                  return async () => {
                    throw Object.assign(new Error(`${home} synthetic-private-value`), {
                      code: "EIO",
                    });
                  };
                }
                const value = Reflect.get(target, property);
                return typeof value === "function" ? value.bind(target) : value;
              },
            });
          }) as typeof fileOpen,
        },
      });
    } catch (error) {
      observed = error;
    }

    expect(observed).toBeInstanceOf(WindowsPrivatePathPolicyError);
    expect(observed).toMatchObject({
      message: "Windows private path policy failed",
      stage: "file-flush",
      category: "io-failure",
    });
    expect(JSON.stringify(observed)).not.toContain(home);
    expect(JSON.stringify(observed)).not.toContain("synthetic-private-value");
    await expect(fileLstat(join(home, "config", "config.yaml"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("prepares the home before seeding and constructing the daemon supervisor", async () => {
    const source = await readFile(resolve(import.meta.dirname, "../src/main/index.ts"), "utf8");
    const prepareCall = source.indexOf("await prepareDesktopAthleteHome(environment)");
    const seedCall = source.indexOf("await seedFirstRunConfig({ env: environment });");
    const supervisorConstruction = source.indexOf("new DesktopDaemonSupervisor(");
    expect(prepareCall).toBeGreaterThan(-1);
    expect(seedCall).toBeGreaterThan(prepareCall);
    expect(supervisorConstruction).toBeGreaterThan(seedCall);
    expect(source).toContain('process.stderr.write("desktop-first-run-config-failure seed\\n");');
  });
});
