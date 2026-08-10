import { rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEVELOPMENT_APP_ID,
  DEVELOPMENT_PACKAGE_NAME,
  DEVELOPMENT_PRODUCT_NAME,
} from "./development-package-plan.mjs";
import { createPackagePlan } from "./package-plan.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const canonicalDesktopRoot = resolve(scriptDirectory, "..");

export const WINDOWS_DEVELOPMENT_OUTPUT_DIRECTORY = "dist/development-windows";
export const WINDOWS_DEVELOPMENT_PLATFORM = "win32";
export const WINDOWS_DEVELOPMENT_ARCH = "x64";
export const WINDOWS_DEVELOPMENT_TARGET = "dir";

export function createWindowsDevelopmentPackagePlan(input = {}) {
  const desktopRoot = input.desktopRoot ?? canonicalDesktopRoot;
  if (!isAbsolute(desktopRoot)) {
    throw new TypeError("desktop root must be absolute");
  }
  const plan = createPackagePlan({
    desktopRoot,
    outputDirectory: WINDOWS_DEVELOPMENT_OUTPUT_DIRECTORY,
    applicationRelativePath: "win-unpacked",
    executableRelativePath: `${DEVELOPMENT_PRODUCT_NAME}.exe`,
    builderConfig: {
      extends: join(desktopRoot, "electron-builder.yml"),
      appId: DEVELOPMENT_APP_ID,
      productName: DEVELOPMENT_PRODUCT_NAME,
      directories: { output: WINDOWS_DEVELOPMENT_OUTPUT_DIRECTORY },
      forceCodeSigning: false,
      extraMetadata: {
        name: DEVELOPMENT_PACKAGE_NAME,
        enduragentDesktopDevelopment: true,
      },
      win: {
        signExecutable: false,
        target: [{ target: WINDOWS_DEVELOPMENT_TARGET, arch: [WINDOWS_DEVELOPMENT_ARCH] }],
      },
    },
  });
  return Object.freeze({
    ...plan,
    platform: WINDOWS_DEVELOPMENT_PLATFORM,
    arch: WINDOWS_DEVELOPMENT_ARCH,
    target: WINDOWS_DEVELOPMENT_TARGET,
    builderOptions: {
      ...plan.builderOptions,
      win: [`${WINDOWS_DEVELOPMENT_TARGET}:${WINDOWS_DEVELOPMENT_ARCH}`],
    },
  });
}

export async function runWindowsDevelopmentPackage(input = {}, dependencies = {}) {
  const plan = createWindowsDevelopmentPackagePlan(input);
  const remove = dependencies.rm ?? rm;
  await remove(plan.outputPath, { recursive: true, force: true });
  const build = dependencies.build ?? (await import("electron-builder")).build;
  const artifacts = await build(plan.builderOptions);
  return Object.freeze({ artifacts, plan });
}

async function main() {
  if (process.argv.length !== 2) throw new TypeError("arguments are not supported");
  const result = await runWindowsDevelopmentPackage();
  process.stdout.write(`windows development application: ${result.plan.applicationPath}\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch {
    process.stderr.write("windows development package build failed\n");
    process.exitCode = 1;
  }
}
