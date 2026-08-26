import type { ObjectEncodingOptions, OpenMode, RmOptions } from "node:fs";
import type { VerifiedWindowsReleaseAssets } from "./verify-windows-release.mjs";
import type { VerifyWindowsReleaseOptions } from "./verify-windows-release.mjs";

export interface WindowsReleaseUploadInput {
  readonly version: string;
  readonly directory: string;
  readonly commit: string;
  readonly authenticode: "verify";
  readonly publisherDn: string;
  readonly appUpdateMetadata: string;
  readonly thumbprint?: string;
  readonly repo?: string;
  readonly record?: string;
}

export interface WindowsReleaseUploadRecord {
  readonly schemaVersion: 1;
  readonly tag: string;
  readonly version: string;
  readonly commit: string;
  readonly tagCommit: string;
  readonly arch: "x64";
  readonly status: "uploaded";
  readonly authenticode: "verified";
  readonly files: readonly {
    readonly name: string;
    readonly size: number;
    readonly sha256: string;
  }[];
}

export interface WindowsReleaseUploadDependencies {
  readonly executeFile?: (
    executable: string,
    arguments_: readonly string[],
  ) => Promise<{ readonly stdout: string }>;
  readonly verifyAssets?: (
    artifactDirectory: string,
    options: VerifyWindowsReleaseOptions,
  ) => Promise<VerifiedWindowsReleaseAssets>;
  readonly readFile?: (path: string) => Promise<Buffer>;
  readonly writeFile?: (
    path: string,
    data: string | Uint8Array,
    options: ObjectEncodingOptions & { readonly mode?: OpenMode; readonly flag?: OpenMode },
  ) => Promise<void>;
  readonly mkdtemp?: (prefix: string) => Promise<string>;
  readonly chmod?: (path: string, mode: number) => Promise<void>;
  readonly rm?: (path: string, options: RmOptions) => Promise<void>;
}

export function safeWindowsReleaseUploadMessage(error: unknown): string | undefined;
export function runWindowsReleaseUpload(
  input: WindowsReleaseUploadInput,
  dependencies?: WindowsReleaseUploadDependencies,
): Promise<WindowsReleaseUploadRecord>;
