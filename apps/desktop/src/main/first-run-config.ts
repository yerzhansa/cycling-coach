import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const FIRST_RUN_CONFIG_DIRECTORY_MODE = 0o700;
export const FIRST_RUN_CONFIG_FILE_MODE = 0o600;

export interface FirstRunConfigFileSystem {
  lstat(path: string): Promise<unknown>;
  mkdir(path: string, options: { readonly recursive: true; readonly mode: number }): Promise<void>;
  writeFile(
    path: string,
    contents: string,
    options: { readonly encoding: "utf8"; readonly flag: "wx"; readonly mode: number },
  ): Promise<void>;
  link(temporaryPath: string, targetPath: string): Promise<void>;
  rm(path: string, options: { readonly force: true }): Promise<void>;
}

export interface FirstRunConfigDependencies {
  readonly fileSystem?: FirstRunConfigFileSystem;
  readonly timezone?: () => string | undefined;
  readonly createId?: () => string;
}

export interface SeedFirstRunConfigInput {
  readonly env?: Record<string, string | undefined>;
  readonly dependencies?: FirstRunConfigDependencies;
}

const nodeFileSystem: FirstRunConfigFileSystem = {
  async lstat(path) {
    await lstat(path);
  },
  async mkdir(path, options) {
    await mkdir(path, options);
  },
  async writeFile(path, contents, options) {
    await writeFile(path, contents, options);
  },
  async link(temporaryPath, targetPath) {
    await link(temporaryPath, targetPath);
  },
  async rm(path, options) {
    await rm(path, options);
  },
};

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

export function resolveDesktopAthleteHome(
  env: Record<string, string | undefined> = process.env,
): string {
  const override = env.ENDURAGENT_HOME;
  return resolve(
    override !== undefined && override.length > 0
      ? expandHome(override)
      : join(homedir(), ".enduragent"),
  );
}

function defaultTimezone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

function yamlPath(path: string): string {
  return /^[/A-Za-z0-9._~@%+=-]+$/.test(path) ? path : JSON.stringify(path);
}

function configContents(homeRoot: string, timezone: string): string {
  return [
    "data_source: store",
    `data_dir: ${yamlPath(homeRoot)}`,
    "llm:",
    "  provider: anthropic",
    "  api_key: ''",
    "intervals:",
    "  api_key: ''",
    "  athlete_id: ''",
    "session:",
    `  timezone: ${timezone}`,
    "",
  ].join("\n");
}

async function exists(fileSystem: FirstRunConfigFileSystem, path: string): Promise<boolean> {
  try {
    await fileSystem.lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function seedFirstRunConfig(
  input: SeedFirstRunConfigInput = {},
): Promise<"seeded" | "existing"> {
  const fileSystem = input.dependencies?.fileSystem ?? nodeFileSystem;
  const homeRoot = resolveDesktopAthleteHome(input.env);
  const configDirectory = join(homeRoot, "config");
  const target = join(configDirectory, "config.yaml");
  if (await exists(fileSystem, target)) return "existing";

  await fileSystem.mkdir(configDirectory, {
    recursive: true,
    mode: FIRST_RUN_CONFIG_DIRECTORY_MODE,
  });
  const temporary = join(
    configDirectory,
    `.config.${(input.dependencies?.createId ?? randomUUID)()}.tmp`,
  );
  const resolvedTimezone = (input.dependencies?.timezone ?? defaultTimezone)();
  const timezone =
    resolvedTimezone === undefined || resolvedTimezone.length === 0 ? "UTC" : resolvedTimezone;
  try {
    await fileSystem.writeFile(temporary, configContents(homeRoot, timezone), {
      encoding: "utf8",
      flag: "wx",
      mode: FIRST_RUN_CONFIG_FILE_MODE,
    });
    try {
      await fileSystem.link(temporary, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await fileSystem.rm(temporary, { force: true });
      return "existing";
    }
    await fileSystem.rm(temporary, { force: true });
    return "seeded";
  } catch (error) {
    await fileSystem.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
