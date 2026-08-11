import type { Stats } from "node:fs";

export type WindowsPackageVerificationStage =
  | "artifact"
  | "installer-inventory"
  | "installer-contract"
  | "application-inventory"
  | "resource-inventory"
  | "asar-inventory"
  | "binary-platform"
  | "cleanup";

export interface WindowsBuilderAuthority {
  readonly asarSourceRoot: string;
  readonly externalSourceRoot: string;
  readonly applicationSourceRoot: string;
  readonly installerHookPath: string;
}

export interface WindowsPackageLayoutOptions {
  readonly desktopRoot?: string;
}

export interface WindowsPackageVerificationOverrides {
  readonly executeFile?: (
    executable: string,
    arguments_: readonly string[],
  ) => Promise<{ readonly stdout: string | Buffer }>;
  readonly extractInstaller?: (artifact: string, destination: string) => Promise<void>;
  readonly extractApplication?: (archive: string, destination: string) => Promise<void>;
  readonly lstat?: (path: string) => Promise<Stats>;
  readonly mkdtemp?: (prefix: string) => Promise<string>;
  readonly readFile?: (path: string) => Promise<Buffer>;
  readonly readVersionFile?: (path: string, encoding: "utf8") => Promise<string>;
  readonly rm?: (
    path: string,
    options: { readonly recursive: true; readonly force: true },
  ) => Promise<void>;
}

export class WindowsPackageVerificationError extends Error {
  readonly stage: WindowsPackageVerificationStage;
  readonly paths: readonly string[];
}

export const WINDOWS_PACKAGE_VERIFICATION_STAGES: readonly WindowsPackageVerificationStage[];

export function safeWindowsPackageVerificationMessage(error: unknown): string | undefined;

export function readWindowsBuilderAuthority(desktopRoot?: string): Promise<WindowsBuilderAuthority>;

export function verifyWindowsPackageLayout(
  application: string,
  options?: WindowsPackageLayoutOptions,
): Promise<void>;

export function verifyWindowsPackage(
  artifact: string,
  options?: WindowsPackageLayoutOptions,
  overrides?: WindowsPackageVerificationOverrides,
): Promise<void>;
