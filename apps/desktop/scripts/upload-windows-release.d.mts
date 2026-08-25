import type { ObjectEncodingOptions, OpenMode } from "node:fs";
import type { VerifiedWindowsReleaseAssets } from "./verify-windows-release.mjs";
import type { VerifyWindowsReleaseOptions } from "./verify-windows-release.mjs";

export interface WindowsReleaseUploadInput {
  readonly version: string;
  readonly directory: string;
  readonly commit: string;
  readonly authenticode: "pending-w19";
  readonly repo?: string;
  readonly record?: string;
}

export interface WindowsReleaseUploadRecord {
  readonly schemaVersion: 1;
  readonly tag: string;
  readonly version: string;
  readonly commit: string;
  readonly arch: "x64";
  readonly authenticode: "pending-w19" | "verified";
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
    data: string,
    options: ObjectEncodingOptions & { readonly mode?: OpenMode; readonly flag?: OpenMode },
  ) => Promise<void>;
}

export function safeWindowsReleaseUploadMessage(error: unknown): string | undefined;
export function runWindowsReleaseUpload(
  input: WindowsReleaseUploadInput,
  dependencies?: WindowsReleaseUploadDependencies,
): Promise<WindowsReleaseUploadRecord>;
