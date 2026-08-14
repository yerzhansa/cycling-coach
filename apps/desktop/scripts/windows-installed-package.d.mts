import type { ReadStream } from "node:fs";
import type { Stats } from "node:fs";
import type { WindowsPackageEvidence } from "./verify-windows-package.mjs";
import type { WindowsPackagePlan } from "./windows-package-plan.mjs";

export interface CanonicalTreeEntry {
  readonly path: string;
  readonly type: "directory" | "file";
  readonly size: number;
  readonly sha256: string | null;
}

export interface CanonicalTreeDependencies {
  readonly lstat?: (path: string) => Promise<Stats>;
  readonly readdir?: (path: string) => Promise<string[]>;
  readonly createReadStream?: (path: string) => ReadStream;
  readonly isAbsolute?: (path: string) => boolean;
  readonly realpath?: (path: string) => Promise<string>;
}

export interface NativeRegistrationEvidence {
  readonly keyPath: string;
  readonly keyName: string;
  readonly displayName: string;
  readonly displayVersion: string;
  readonly installLocation: string;
  readonly uninstallString: string;
  readonly quietUninstallString: string;
}

export interface NativeSignatureEvidence {
  readonly path: string;
  readonly status: string;
  readonly statusMessage?: string;
  readonly signerSubject?: string | null;
}

export interface NativeInstalledEvidence {
  readonly ok: true;
  readonly registrations: readonly NativeRegistrationEvidence[];
  readonly programResidues: readonly string[];
  readonly processes: readonly { readonly id: number; readonly executablePath: string }[];
  readonly shortcut: {
    readonly path: string;
    readonly exists: boolean;
    readonly targetPath: string | null;
    readonly arguments: string | null;
    readonly workingDirectory: string | null;
  };
  readonly run: { readonly exists: boolean; readonly value: string | null };
  readonly startupApproved: {
    readonly exists: boolean;
    readonly valueBase64: string | null;
  };
  readonly reparsePaths: readonly string[];
  readonly signatures: readonly NativeSignatureEvidence[];
}

export interface WindowsInstalledPackageResult {
  readonly installer: string;
  readonly application: string;
  readonly installRoot: string;
  readonly installerSha256: string;
  readonly uninstallerSha256: string;
}

export interface WindowsInstalledPackageDependencies extends CanonicalTreeDependencies {
  readonly createWindowsPackagePlan?: (input: {
    readonly desktopRoot: string;
  }) => Promise<WindowsPackagePlan>;
  readonly verifyWindowsPackage?: (
    installer: string,
    application: string,
    options: { readonly desktopRoot: string },
  ) => Promise<WindowsPackageEvidence>;
  readonly runNativeEvidence?: (
    request: Record<string, unknown>,
    scratch: string,
    dependencies?: WindowsInstalledPackageDependencies,
  ) => Promise<NativeInstalledEvidence>;
  readonly capture?: (
    file: string,
    args: readonly string[],
    timeoutMs: number,
    options?: Record<string, unknown>,
  ) => Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly stdout: string;
    readonly stderr: string;
  }>;
  readonly delay?: (milliseconds: number) => Promise<void>;
}

export const WINDOWS_INSTALLED_LIMITS: {
  readonly installProcessMs: 120000;
  readonly filesystemMs: 30000;
  readonly commandMs: 120000;
  readonly listenerMs: 500;
  readonly cleanupGraceMs: 5000;
};

export function collectCanonicalTree(
  root: string,
  dependencies?: CanonicalTreeDependencies,
): Promise<readonly CanonicalTreeEntry[]>;

export function compareInstalledTree(
  retainedEntries: readonly CanonicalTreeEntry[],
  installedEntries: readonly CanonicalTreeEntry[],
  uninstallerRelativePath: string,
): { readonly uninstaller: CanonicalTreeEntry };

export function parseRegisteredUninstallCommands(
  registration: Pick<NativeRegistrationEvidence, "uninstallString" | "quietUninstallString">,
  installRoot: string,
): {
  readonly uninstaller: string;
  readonly uninstallArgs: readonly ["/currentuser"];
  readonly quietArgs: readonly ["/currentuser", "/S"];
};

export function discoverInstalledPackage(
  evidence: Pick<NativeInstalledEvidence, "registrations">,
  expected: {
    readonly productName: string;
    readonly version: string;
    readonly localAppData: string;
    readonly guid: string;
  },
): {
  readonly registration: NativeRegistrationEvidence;
  readonly installRoot: string;
  readonly executable: string;
  readonly uninstaller: string;
  readonly uninstallArgs: readonly ["/currentuser"];
  readonly quietArgs: readonly ["/currentuser", "/S"];
};

export function validateSignaturePolicy(
  evidence: readonly NativeSignatureEvidence[],
  policy: string,
  ownedPaths: readonly string[],
  expectedPaths?: readonly string[],
): true;

export function executeWithGuaranteedUninstall(
  primary: () => Promise<void>,
  uninstall: () => Promise<void>,
): Promise<void>;

export function runWindowsInstalledPackage(
  input?: {
    readonly args?: readonly string[];
    readonly environment?: NodeJS.ProcessEnv;
    readonly desktopRoot?: string;
    readonly platform?: NodeJS.Platform;
    readonly arch?: string;
  },
  dependencies?: WindowsInstalledPackageDependencies,
): Promise<WindowsInstalledPackageResult>;

export function main(): Promise<void>;
