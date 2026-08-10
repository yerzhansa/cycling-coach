import { chmod, lstat, mkdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, parse, resolve } from "node:path";
import type { AthleteHome } from "./resolve-athlete-home.js";
import { prepareWindowsAthleteHome } from "./windows-home-policy.js";

const PRIVATE_DIRECTORY_MODE = 0o700;

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { readonly code?: unknown }).code === code
  );
}

function validateChildEntry(entry: Awaited<ReturnType<typeof lstat>>, name: string): void {
  if (entry.isSymbolicLink()) {
    throw new TypeError(`Athlete home ${name} directory must not be a symbolic link.`);
  }
  if (!entry.isDirectory()) {
    throw new TypeError(`Athlete home ${name} path must be a directory.`);
  }
}

async function prepareChildDirectory(path: string, name: string): Promise<void> {
  let entry: Awaited<ReturnType<typeof lstat>>;
  try {
    entry = await lstat(path);
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
    try {
      await mkdir(path, { mode: PRIVATE_DIRECTORY_MODE });
    } catch (mkdirError) {
      if (!hasErrorCode(mkdirError, "EEXIST")) throw mkdirError;
    }
    entry = await lstat(path);
  }
  validateChildEntry(entry, name);
  const physicalPath = await realpath(path);
  if (physicalPath !== path) {
    throw new TypeError(`Athlete home ${name} directory escaped its physical root.`);
  }
  validateChildEntry(await lstat(path), name);
  await chmod(physicalPath, PRIVATE_DIRECTORY_MODE);
}

function validateChildLayout(home: AthleteHome): void {
  if (!isAbsolute(home.root)) {
    throw new TypeError("Athlete home root must be absolute.");
  }
  const root = resolve(home.root);
  for (const [name, path] of [
    ["store", home.storeDir],
    ["archive", home.archiveDir],
    ["config", home.configDir],
  ] as const) {
    if (resolve(path) !== join(root, name)) {
      throw new TypeError("Athlete home must use the fixed child layout.");
    }
  }
}

async function prepareRootDirectory(path: string): Promise<string> {
  try {
    await lstat(path);
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
    await mkdir(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  }
  if (!(await stat(path)).isDirectory()) {
    throw new TypeError("Athlete home root must be a directory.");
  }
  const physicalPath = await realpath(path);
  if (physicalPath === parse(physicalPath).root) {
    throw new TypeError("Athlete home must not be the filesystem root.");
  }
  await chmod(physicalPath, PRIVATE_DIRECTORY_MODE);
  return physicalPath;
}

export interface PrepareAthleteHomeOptions {
  readonly platform?: NodeJS.Platform;
}

export async function prepareAthleteHome(
  home: AthleteHome,
  options: PrepareAthleteHomeOptions = {},
): Promise<AthleteHome> {
  if ((options.platform ?? process.platform) === "win32") {
    return prepareWindowsAthleteHome(home);
  }
  validateChildLayout(home);
  const root = await prepareRootDirectory(home.root);

  const prepared = {
    root,
    storeDir: join(root, "store"),
    archiveDir: join(root, "archive"),
    configDir: join(root, "config"),
  } satisfies AthleteHome;

  for (const [name, path] of [
    ["store", prepared.storeDir],
    ["archive", prepared.archiveDir],
    ["config", prepared.configDir],
  ] as const) {
    await prepareChildDirectory(path, name);
  }

  return Object.freeze(prepared);
}
