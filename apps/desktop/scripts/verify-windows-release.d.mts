import type { Stats } from "node:fs";
import type { WindowsReleaseArtifactNames } from "./windows-release-plan.mjs";

export type WindowsAuthenticodeMode =
  | "pending-w19"
  | {
      readonly mode?: "verify";
      readonly expectedPublisherDn?: string;
      readonly verify: (
        installerPath: string,
        context: {
          readonly version: string;
          readonly commit: string;
          readonly publisherName?: string;
        },
      ) => Promise<void>;
    };

export interface VerifyWindowsReleaseOptions {
  readonly version: string;
  readonly commit?: string;
  readonly expectedPublisherName?: string;
  readonly appUpdateMetadata?: string | Uint8Array;
  readonly authenticode: WindowsAuthenticodeMode;
}

export interface VerifyWindowsReleaseDependencies {
  readonly lstat?: (path: string) => Promise<Stats>;
  readonly readdir?: (path: string) => Promise<string[]>;
  readonly readFile?: (path: string) => Promise<Buffer>;
  readonly notice?: (message: string) => void;
}

export interface VerifiedWindowsReleaseAssets {
  readonly version: string;
  readonly commit: string | null;
  readonly names: WindowsReleaseArtifactNames;
  readonly paths: {
    readonly installer: string;
    readonly blockmap: string;
    readonly metadata: string;
  };
  readonly sizes: {
    readonly installer: number;
    readonly blockmap: number;
    readonly metadata: number;
  };
  readonly installerSha512: string;
  readonly installerSha256: string;
  readonly authenticode: "pending-w19" | "verified";
}

export const WINDOWS_UPDATER_METADATA_MAX_BYTES: 16_384;
export function safeWindowsReleaseVerificationMessage(error: unknown): string | undefined;
export function checkWindowsInstallerBlockmap(
  blockmap: Uint8Array,
  installer: Uint8Array,
): string | null;
export function verifyWindowsReleaseAssets(
  artifactDirectory: string,
  options: VerifyWindowsReleaseOptions,
  overrides?: VerifyWindowsReleaseDependencies,
): Promise<VerifiedWindowsReleaseAssets>;
