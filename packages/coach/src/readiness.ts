import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { engineConfigFromConfig, loadConfig } from "@enduragent/core";
import type { EngineConfig } from "@enduragent/engine";
import type { AthleteHome } from "@enduragent/kernel-node/home";
import { parse as parseYaml } from "yaml";

export type ReadinessResult =
  | { status: "ready"; config: EngineConfig }
  | { status: "not-configured"; configPath: string };

function isMap(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function checkHomeReadiness(home: AthleteHome): Promise<ReadinessResult> {
  const configPath = join(home.configDir, "config.yaml");
  try {
    const parsedYaml = parseYaml(await readFile(configPath, "utf8")) as unknown;
    if (!isMap(parsedYaml)) return { status: "not-configured", configPath };
    const config = loadConfig(home.configDir, { defaultDataDir: home.root });
    const profileName = config.llm.authProfile;
    if (profileName !== undefined) {
      const profiles = JSON.parse(
        await readFile(join(home.configDir, "auth-profiles.json"), "utf8"),
      ) as unknown;
      if (!isMap(profiles) || !Object.hasOwn(profiles, profileName)) {
        return { status: "not-configured", configPath };
      }
    }
    return { status: "ready", config: engineConfigFromConfig(config) };
  } catch {
    return { status: "not-configured", configPath };
  }
}
