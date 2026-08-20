import { spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { machoExecutableIdentity } from "./package-inventory.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const canonicalDesktopRoot = resolve(scriptDirectory, "..");

export const KEYCHAIN_HELPER_FILE = "keychain-helper";
export const KEYCHAIN_HELPER_BUILD_DIRECTORY = "dist/keychain-helper";
export const KEYCHAIN_HELPER_SOURCE = "native/keychain-helper/main.swift";
export const KEYCHAIN_HELPER_SWIFT_TARGET = "arm64-apple-macos12.0";
export const KEYCHAIN_HELPER_COMPILE_TIMEOUT_MS = 300_000;

export function keychainHelperBuildPath(desktopRoot = canonicalDesktopRoot) {
  return join(desktopRoot, KEYCHAIN_HELPER_BUILD_DIRECTORY, KEYCHAIN_HELPER_FILE);
}

export function keychainHelperCompilerAvailable() {
  const probe = spawnSync("swiftc", ["-version"], { stdio: "ignore" });
  return probe.error === undefined && probe.status === 0;
}

export async function buildKeychainHelper(desktopRoot = canonicalDesktopRoot) {
  if (process.platform !== "darwin") return undefined;
  if (!keychainHelperCompilerAvailable()) {
    throw new Error("swiftc is required to build the macOS keychain helper");
  }
  const buildRoot = join(desktopRoot, KEYCHAIN_HELPER_BUILD_DIRECTORY);
  const temporaryRoot = join(desktopRoot, "dist", `.keychain-helper-${process.pid}`);
  await rm(temporaryRoot, { recursive: true, force: true });
  await mkdir(temporaryRoot, { recursive: true });
  try {
    const temporaryBinary = join(temporaryRoot, KEYCHAIN_HELPER_FILE);
    const compile = spawnSync(
      "swiftc",
      [
        join(desktopRoot, KEYCHAIN_HELPER_SOURCE),
        "-O",
        "-target",
        KEYCHAIN_HELPER_SWIFT_TARGET,
        "-o",
        temporaryBinary,
      ],
      { cwd: temporaryRoot, encoding: "utf8", timeout: KEYCHAIN_HELPER_COMPILE_TIMEOUT_MS },
    );
    if (compile.error !== undefined || compile.status !== 0 || compile.signal !== null) {
      if (typeof compile.stderr === "string" && compile.stderr.length > 0) {
        process.stderr.write(compile.stderr);
      }
      throw new Error("keychain helper compilation failed");
    }
    machoExecutableIdentity(await readFile(temporaryBinary), KEYCHAIN_HELPER_BUILD_DIRECTORY);
    await chmod(temporaryBinary, 0o755);
    await rm(buildRoot, { recursive: true, force: true });
    await rename(temporaryRoot, buildRoot);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
  return keychainHelperBuildPath(desktopRoot);
}

async function main() {
  if (process.argv.length !== 2) throw new Error("arguments are not supported");
  const built = await buildKeychainHelper();
  process.stdout.write(
    built === undefined
      ? "keychain helper build skipped on this platform\n"
      : `keychain helper: ${KEYCHAIN_HELPER_BUILD_DIRECTORY}/${KEYCHAIN_HELPER_FILE}\n`,
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
