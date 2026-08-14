import type { Stats } from "node:fs";

export type WindowsPackageVerificationStage =
  | "artifact"
  | "installer-contract"
  | "application-inventory"
  | "resource-inventory"
  | "asar-inventory"
  | "binary-platform";

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
  readonly lstat?: (path: string) => Promise<Stats>;
  readonly readFile?: (path: string) => Promise<Buffer>;
  readonly readVersionFile?: (path: string, encoding: "utf8") => Promise<string>;
}

export interface WindowsApplicationEvidence {
  readonly fileCount: number;
  readonly directoryCount: number;
  readonly manifestSha256: string;
  readonly peMachine: 0x8664;
}

export interface WindowsPackageEvidence {
  readonly artifact: {
    readonly name: string;
    readonly size: number;
    readonly sha256: string;
    readonly peMachine: 0x014c | 0x8664;
    readonly nsisEnvelope: true;
  };
  readonly application: WindowsApplicationEvidence;
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
): Promise<WindowsApplicationEvidence>;

export function verifyWindowsPackage(
  artifact: string,
  application: string,
  options?: WindowsPackageLayoutOptions,
  overrides?: WindowsPackageVerificationOverrides,
): Promise<WindowsPackageEvidence>;
