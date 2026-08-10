import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEVELOPMENT_APP_ID,
  DEVELOPMENT_PACKAGE_NAME,
  DEVELOPMENT_PRODUCT_NAME,
  createDevelopmentPackagePlan,
} from "../scripts/development-package-plan.mjs";
import { createPackagePlan } from "../scripts/package-plan.mjs";
import {
  WINDOWS_DEVELOPMENT_ARCH,
  WINDOWS_DEVELOPMENT_OUTPUT_DIRECTORY,
  WINDOWS_DEVELOPMENT_PLATFORM,
  WINDOWS_DEVELOPMENT_TARGET,
  createWindowsDevelopmentPackagePlan,
} from "../scripts/windows-development-package-plan.mjs";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function windowsPackageInput() {
  return {
    desktopRoot,
    outputDirectory: WINDOWS_DEVELOPMENT_OUTPUT_DIRECTORY,
    applicationRelativePath: "win-unpacked",
    executableRelativePath: `${DEVELOPMENT_PRODUCT_NAME}.exe`,
    builderConfig: {},
  };
}

describe("Windows development package plan", () => {
  it("seals the exact win-unpacked x64 directory plan", () => {
    const plan = createWindowsDevelopmentPackagePlan({ desktopRoot });
    const outputPath = join(desktopRoot, WINDOWS_DEVELOPMENT_OUTPUT_DIRECTORY);
    const applicationPath = join(outputPath, "win-unpacked");

    expect(plan).toEqual({
      applicationPath,
      executablePath: join(applicationPath, `${DEVELOPMENT_PRODUCT_NAME}.exe`),
      outputPath,
      builderOptions: {
        projectDir: desktopRoot,
        publish: "never",
        win: [`${WINDOWS_DEVELOPMENT_TARGET}:${WINDOWS_DEVELOPMENT_ARCH}`],
        config: {
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
      },
      platform: WINDOWS_DEVELOPMENT_PLATFORM,
      arch: WINDOWS_DEVELOPMENT_ARCH,
      target: WINDOWS_DEVELOPMENT_TARGET,
    });
    expect(Object.isFrozen(plan)).toBe(true);
    expect([plan.outputPath, plan.applicationPath, plan.executablePath].every(isAbsolute)).toBe(
      true,
    );
    expect(relative(desktopRoot, plan.outputPath)).toBe(join("dist", "development-windows"));
    expect(relative(plan.outputPath, plan.applicationPath)).toBe("win-unpacked");
    expect(relative(plan.applicationPath, plan.executablePath)).toBe(
      `${DEVELOPMENT_PRODUCT_NAME}.exe`,
    );
  });

  it("mirrors the macOS development identity while selecting the Windows target", () => {
    const windows = createWindowsDevelopmentPackagePlan({ desktopRoot });
    const macos = createDevelopmentPackagePlan({ desktopRoot });
    const windowsConfig = windows.builderOptions.config;
    const macosConfig = macos.builderOptions.config;

    expect({
      appId: windowsConfig.appId,
      productName: windowsConfig.productName,
      forceCodeSigning: windowsConfig.forceCodeSigning,
      extraMetadata: windowsConfig.extraMetadata,
    }).toEqual({
      appId: macosConfig.appId,
      productName: macosConfig.productName,
      forceCodeSigning: macosConfig.forceCodeSigning,
      extraMetadata: macosConfig.extraMetadata,
    });
    expect(windows.builderOptions.win).toEqual(["dir:x64"]);
    expect(windowsConfig.win).toEqual({
      signExecutable: false,
      target: [{ target: "dir", arch: ["x64"] }],
    });
  });

  it("rejects non-absolute roots and absolute or escaping Windows plan children", () => {
    const valid = windowsPackageInput();

    expect(() => createWindowsDevelopmentPackagePlan({ desktopRoot: "relative" })).toThrow(
      "desktop root must be absolute",
    );
    expect(() =>
      createPackagePlan({
        ...valid,
        outputDirectory: resolve(desktopRoot, WINDOWS_DEVELOPMENT_OUTPUT_DIRECTORY),
      }),
    ).toThrow("package output directory must be relative");
    expect(() =>
      createPackagePlan({ ...valid, outputDirectory: "../development-windows" }),
    ).toThrow("package output directory must be inside desktop root");
    expect(() =>
      createPackagePlan({
        ...valid,
        applicationRelativePath: resolve(valid.desktopRoot, "win-unpacked"),
      }),
    ).toThrow("application path must be relative to package output");
    expect(() =>
      createPackagePlan({ ...valid, applicationRelativePath: "../win-unpacked" }),
    ).toThrow("application path must be inside package output");
    expect(() =>
      createPackagePlan({
        ...valid,
        executableRelativePath: resolve(valid.desktopRoot, `${DEVELOPMENT_PRODUCT_NAME}.exe`),
      }),
    ).toThrow("executable path must be relative to application");
    expect(() =>
      createPackagePlan({
        ...valid,
        executableRelativePath: `../${DEVELOPMENT_PRODUCT_NAME}.exe`,
      }),
    ).toThrow("executable path must be inside application");
  });
});
