import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const roots: string[] = [];

async function freshDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(await realpath(tmpdir()), prefix));
  roots.push(directory);
  return directory;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetModules();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("config data directory", () => {
  it("preserves no-argument and one-argument legacy defaults and runtime arity", async () => {
    const defaultConfigDir = await freshDirectory("core-default-config-");
    const suppliedConfigDir = await freshDirectory("core-supplied-config-");
    vi.stubEnv("CYCLING_COACH_HOME", defaultConfigDir);
    vi.resetModules();
    const { loadConfig } = await import("../src/config.js");

    expect(loadConfig.length).toBe(0);
    expect(loadConfig().dataDir).toBe(defaultConfigDir);
    expect(loadConfig(suppliedConfigDir).dataDir).toBe(suppliedConfigDir);
  });

  it("uses the caller default only when data_dir is absent", async () => {
    const configDir = await freshDirectory("core-context-config-");
    const athleteRoot = await freshDirectory("core-context-root-");
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, "config.yaml"), "data_source: store\n", { mode: 0o600 });
    const { loadConfig } = await import("../src/config.js");

    expect(loadConfig(configDir, { defaultDataDir: athleteRoot }).dataDir).toBe(athleteRoot);
  });

  it("loads an already parsed snapshot without reading the configuration file again", async () => {
    const configDir = await freshDirectory("core-snapshot-config-");
    const athleteRoot = await freshDirectory("core-snapshot-root-");
    const { loadConfigFromYaml } = await import("../src/config.js");

    expect(
      loadConfigFromYaml({ data_source: "store" }, configDir, {
        defaultDataDir: athleteRoot,
      }),
    ).toMatchObject({ dataSource: "store", dataDir: athleteRoot });
  });

  it("preserves explicit YAML values and keeps null on its legacy fallback", async () => {
    const configDir = await freshDirectory("core-explicit-config-");
    const athleteRoot = await freshDirectory("core-explicit-root-");
    const otherRoot = await freshDirectory("core-other-root-");
    const { loadConfig } = await import("../src/config.js");
    const cases = [
      { yaml: "data_dir: null\n", expected: configDir },
      { yaml: 'data_dir: ""\n', expected: "" },
      { yaml: "data_dir: relative\n", expected: "relative" },
      { yaml: `data_dir: ${JSON.stringify(configDir)}\n`, expected: configDir },
      { yaml: `data_dir: ${JSON.stringify(otherRoot)}\n`, expected: otherRoot },
    ];

    for (const testCase of cases) {
      await writeFile(join(configDir, "config.yaml"), testCase.yaml, { mode: 0o600 });
      expect(loadConfig(configDir, { defaultDataDir: athleteRoot }).dataDir).toBe(
        testCase.expected,
      );
    }
  });
});
