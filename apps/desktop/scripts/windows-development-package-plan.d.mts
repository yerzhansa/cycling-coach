export interface WindowsDevelopmentPackageInput {
  readonly desktopRoot?: string;
}

export interface WindowsDevelopmentPackageBuilderOptions {
  readonly projectDir: string;
  readonly publish: "never";
  readonly win: readonly ["dir:x64"];
  readonly config: {
    readonly extends: string;
    readonly appId: "icu.enduragent.desktop.development";
    readonly productName: "Enduragent Development";
    readonly directories: {
      readonly output: "dist/development-windows";
    };
    readonly forceCodeSigning: false;
    readonly extraMetadata: {
      readonly name: "enduragent-desktop-development";
      readonly enduragentDesktopDevelopment: true;
    };
    readonly win: {
      readonly signExecutable: false;
      readonly target: readonly [{ readonly target: "dir"; readonly arch: readonly ["x64"] }];
    };
  };
}

export interface WindowsDevelopmentPackagePlan {
  readonly platform: "win32";
  readonly arch: "x64";
  readonly target: "dir";
  readonly applicationPath: string;
  readonly executablePath: string;
  readonly outputPath: string;
  readonly builderOptions: WindowsDevelopmentPackageBuilderOptions;
}

export interface WindowsDevelopmentPackageDependencies {
  readonly rm?: (
    path: string,
    options: { readonly recursive: true; readonly force: true },
  ) => Promise<void>;
  readonly build?: (
    options: WindowsDevelopmentPackageBuilderOptions,
  ) => Promise<readonly string[]>;
}

export const WINDOWS_DEVELOPMENT_OUTPUT_DIRECTORY: "dist/development-windows";
export const WINDOWS_DEVELOPMENT_PLATFORM: "win32";
export const WINDOWS_DEVELOPMENT_ARCH: "x64";
export const WINDOWS_DEVELOPMENT_TARGET: "dir";

export function createWindowsDevelopmentPackagePlan(
  input?: WindowsDevelopmentPackageInput,
): WindowsDevelopmentPackagePlan;

export function runWindowsDevelopmentPackage(
  input?: WindowsDevelopmentPackageInput,
  dependencies?: WindowsDevelopmentPackageDependencies,
): Promise<{
  readonly artifacts: readonly string[];
  readonly plan: WindowsDevelopmentPackagePlan;
}>;
