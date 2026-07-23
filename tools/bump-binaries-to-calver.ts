#!/usr/bin/env tsx

import { execFileSync as nodeExecFileSync } from "node:child_process";
import {
  existsSync as nodeExistsSync,
  readFileSync as nodeReadFileSync,
  writeFileSync as nodeWriteFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

export const BINARY_PACKAGES = ["cycling-coach"] as const;

export interface CalVer {
  readonly version: string;
  readonly year: number;
  readonly month: number;
  readonly patch: number;
  readonly legacyRevision: number;
}

const CALVER_PATTERN = /^([1-9]\d{3})\.([1-9]\d*)\.(0|[1-9]\d*)(?:-(0|[1-9]\d*))?$/;
const IGNORED_LEGACY_REGISTRY_VERSIONS = new Set(["0.0.1"]);

export function parseCalVer(version: string): CalVer | null {
  const match = CALVER_PATTERN.exec(version);
  if (match === null) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const patch = Number(match[3]);
  const legacyRevision = match[4] === undefined ? 0 : Number(match[4]);
  if (month > 12 || !Number.isSafeInteger(patch) || !Number.isSafeInteger(legacyRevision)) {
    return null;
  }
  return { version, year, month, patch, legacyRevision };
}

export function parseRegistryVersions(registryJson: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(registryJson);
  } catch {
    throw new Error("npm registry JSON is malformed");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("npm registry JSON must contain a versions array");
  }
  return parsed.flatMap((version, index) => {
    if (typeof version !== "string") {
      throw new Error(`Malformed npm registry version at index ${index}`);
    }
    if (IGNORED_LEGACY_REGISTRY_VERSIONS.has(version)) return [];
    if (parseCalVer(version) === null) {
      throw new Error(`Malformed npm registry version at index ${index}`);
    }
    return [version];
  });
}

function compareCalVer(left: CalVer, right: CalVer): number {
  for (const key of ["year", "month", "patch", "legacyRevision"] as const) {
    if (left[key] !== right[key]) return left[key] - right[key];
  }
  return 0;
}

export function nextCalVer(occupiedVersions: readonly string[], now: Date): string {
  if (Number.isNaN(now.getTime())) throw new Error("Current UTC clock is invalid");
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  if (year < 1000 || year > 9999) {
    throw new Error(`Current UTC year ${year} cannot be represented as CalVer`);
  }

  const occupied = occupiedVersions.map((version) => {
    const parsed = parseCalVer(version);
    if (parsed === null) throw new Error(`Invalid occupied CalVer version: ${version}`);
    return parsed;
  });
  if (occupied.length === 0) throw new Error("At least one occupied CalVer version is required");

  const maximum = occupied.reduce((left, right) =>
    compareCalVer(left, right) >= 0 ? left : right,
  );
  if (year < maximum.year || (year === maximum.year && month < maximum.month)) {
    throw new Error(
      `Current UTC period ${year}.${month} precedes occupied version ${maximum.version}`,
    );
  }
  if (year !== maximum.year || month !== maximum.month) return `${year}.${month}.0`;
  if (maximum.patch === Number.MAX_SAFE_INTEGER) {
    throw new Error(`CalVer patch would overflow after ${maximum.version}`);
  }
  return `${year}.${month}.${maximum.patch + 1}`;
}

export interface ChangelogRewrite {
  readonly contents: string;
  readonly changed: boolean;
}

export function rewriteFirstChangelogHeader(
  contents: string,
  oldVersion: string,
  newVersion: string,
): ChangelogRewrite {
  const heading = /^## ([^\r\n]+)(?=\r?$)/m.exec(contents);
  if (heading === null || heading[1] !== oldVersion) return { contents, changed: false };
  const headerNeedle = heading[0];
  const headerIndex = heading.index;
  return {
    contents:
      contents.slice(0, headerIndex) +
      `## ${newVersion}` +
      contents.slice(headerIndex + headerNeedle.length),
    changed: true,
  };
}

export interface BinaryVersionPlanInput {
  readonly packageName: string;
  readonly packageJsonPath: string;
  readonly changelogPath: string;
  readonly packageJsonContents: string;
  readonly committedPackageJsonContents: string;
  readonly registryVersionsJson: string;
  readonly changelogContents?: string;
  readonly now: Date;
}

export interface BinaryVersionPlan {
  readonly packageName: string;
  readonly packageJsonPath: string;
  readonly changelogPath: string;
  readonly oldVersion: string;
  readonly committedVersion: string;
  readonly newVersion: string;
  readonly packageJsonContents: string;
  readonly changelogContents?: string;
  readonly packageChanged: boolean;
  readonly changelogChanged: boolean;
}

function parsePackageManifest(
  contents: string,
  label: string,
): { manifest: Record<string, unknown>; version: string } {
  let manifest: unknown;
  try {
    manifest = JSON.parse(contents);
  } catch {
    throw new Error(`${label} package.json is malformed`);
  }
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    typeof (manifest as Record<string, unknown>).version !== "string" ||
    ((manifest as Record<string, unknown>).version as string).length === 0
  ) {
    throw new Error(`${label} package.json has an invalid version`);
  }
  return {
    manifest: manifest as Record<string, unknown>,
    version: (manifest as Record<string, unknown>).version as string,
  };
}

export function planBinaryVersionBump(input: BinaryVersionPlanInput): BinaryVersionPlan {
  const working = parsePackageManifest(input.packageJsonContents, input.packageName);
  const committed = parsePackageManifest(
    input.committedPackageJsonContents,
    `${input.packageName} committed`,
  );
  if (parseCalVer(committed.version) === null) {
    throw new Error(
      `${input.packageName} committed version is not valid CalVer: ${committed.version}`,
    );
  }

  if (input.changelogContents === undefined) {
    throw new Error(`${input.packageName}: CHANGELOG.md is required`);
  }
  const currentHeading = /^## ([^\r\n]+)(?=\r?$)/m.exec(input.changelogContents);
  if (currentHeading === null || currentHeading[1] !== working.version) {
    throw new Error(`${input.packageName}: CHANGELOG.md top release header is inconsistent`);
  }

  if (working.version === committed.version) {
    return {
      packageName: input.packageName,
      packageJsonPath: input.packageJsonPath,
      changelogPath: input.changelogPath,
      oldVersion: working.version,
      committedVersion: committed.version,
      newVersion: working.version,
      packageJsonContents: input.packageJsonContents,
      changelogContents: input.changelogContents,
      packageChanged: false,
      changelogChanged: false,
    };
  }

  const publishedVersions = parseRegistryVersions(input.registryVersionsJson);
  const newVersion = nextCalVer([committed.version, ...publishedVersions], input.now);
  const packageChanged = working.version !== newVersion;
  const packageJsonContents = packageChanged
    ? `${JSON.stringify({ ...working.manifest, version: newVersion }, null, 2)}\n`
    : input.packageJsonContents;

  let changelogContents = input.changelogContents;
  let changelogChanged = false;
  if (packageChanged) {
    const rewrite = rewriteFirstChangelogHeader(changelogContents, working.version, newVersion);
    if (!rewrite.changed) {
      throw new Error(`${input.packageName}: CHANGELOG.md top release header is inconsistent`);
    }
    changelogContents = rewrite.contents;
    changelogChanged = rewrite.changed;
  }
  const plannedHeading = /^## ([^\r\n]+)(?=\r?$)/m.exec(changelogContents);
  if (plannedHeading === null || plannedHeading[1] !== newVersion) {
    throw new Error(`${input.packageName}: CHANGELOG.md planned release header is inconsistent`);
  }

  return {
    packageName: input.packageName,
    packageJsonPath: input.packageJsonPath,
    changelogPath: input.changelogPath,
    oldVersion: working.version,
    committedVersion: committed.version,
    newVersion,
    packageJsonContents,
    changelogContents,
    packageChanged,
    changelogChanged,
  };
}

interface CommandOptions {
  readonly cwd: string;
  readonly encoding: "utf8";
  readonly stdio: readonly ["ignore", "pipe", "pipe"];
  readonly timeout: number;
}

export interface CalVerBumpDependencies {
  readonly execFileSync: (
    command: string,
    args: readonly string[],
    options: CommandOptions,
  ) => string;
  readonly readFileSync: (path: string, encoding: "utf8") => string;
  readonly writeFileSync: (path: string, contents: string) => void;
  readonly existsSync: (path: string) => boolean;
  readonly log: (message: string) => void;
}

export interface CalVerBumpOptions {
  readonly rootDir?: string;
  readonly now?: Date;
  readonly packages?: readonly string[];
  readonly dependencies?: Partial<CalVerBumpDependencies>;
}

const defaultDependencies: CalVerBumpDependencies = {
  execFileSync(command, args, options) {
    return nodeExecFileSync(command, [...args], {
      cwd: options.cwd,
      encoding: options.encoding,
      stdio: [...options.stdio],
      timeout: options.timeout,
    });
  },
  readFileSync(path, encoding) {
    return nodeReadFileSync(path, encoding);
  },
  writeFileSync(path, contents) {
    nodeWriteFileSync(path, contents);
  },
  existsSync(path) {
    return nodeExistsSync(path);
  },
  log(message) {
    console.log(message);
  },
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function commandOutput(
  dependencies: CalVerBumpDependencies,
  command: string,
  args: readonly string[],
  rootDir: string,
  label: string,
): string {
  try {
    return dependencies.execFileSync(command, args, {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });
  } catch {
    throw new Error(`${label} failed`);
  }
}

export function main(options: CalVerBumpOptions = {}): BinaryVersionPlan[] {
  const rootDir = options.rootDir ?? process.cwd();
  const now = options.now ?? new Date();
  const packages = options.packages ?? BINARY_PACKAGES;
  const dependencies: CalVerBumpDependencies = {
    ...defaultDependencies,
    ...options.dependencies,
  };

  const plans: BinaryVersionPlan[] = [];
  for (const packageName of packages) {
    const packageJsonPath = join(rootDir, "packages", packageName, "package.json");
    const changelogPath = join(rootDir, "packages", packageName, "CHANGELOG.md");
    const packageJsonContents = dependencies.readFileSync(packageJsonPath, "utf8");
    const committedPackageJsonContents = commandOutput(
      dependencies,
      "git",
      ["show", `HEAD:packages/${packageName}/package.json`],
      rootDir,
      `git show for ${packageName}`,
    );
    const workingVersion = parsePackageManifest(packageJsonContents, packageName).version;
    const committedVersion = parsePackageManifest(
      committedPackageJsonContents,
      `${packageName} committed`,
    ).version;
    const registryVersionsJson =
      workingVersion === committedVersion
        ? "[]"
        : commandOutput(
            dependencies,
            "npm",
            ["view", packageName, "versions", "--json", "--registry=https://registry.npmjs.org"],
            rootDir,
            `npm view ${packageName} versions`,
          );
    const changelogContents = dependencies.existsSync(changelogPath)
      ? dependencies.readFileSync(changelogPath, "utf8")
      : undefined;

    plans.push(
      planBinaryVersionBump({
        packageName,
        packageJsonPath,
        changelogPath,
        packageJsonContents,
        committedPackageJsonContents,
        registryVersionsJson,
        changelogContents,
        now,
      }),
    );
  }

  for (const plan of plans) {
    if (!plan.packageChanged) {
      dependencies.log(`${plan.packageName}: already ${plan.newVersion} (no bump)`);
      continue;
    }
    dependencies.writeFileSync(plan.packageJsonPath, plan.packageJsonContents);
    if (plan.changelogChanged && plan.changelogContents !== undefined) {
      dependencies.writeFileSync(plan.changelogPath, plan.changelogContents);
      dependencies.log(
        `${plan.packageName}: CHANGELOG.md header ${plan.oldVersion} → ${plan.newVersion}`,
      );
    }
    dependencies.log(`${plan.packageName}: ${plan.oldVersion} → ${plan.newVersion}`);
  }

  return plans;
}

export function runCli(
  options: CalVerBumpOptions = {},
  reportError: (message: string) => void = (message) => console.error(message),
): number {
  try {
    main(options);
    return 0;
  } catch (error) {
    reportError(errorMessage(error));
    return 1;
  }
}

const isCliEntry =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCliEntry) {
  process.exitCode = runCli();
}
