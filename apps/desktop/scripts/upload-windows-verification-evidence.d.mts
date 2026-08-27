export interface WindowsVerificationEvidenceUploadInput {
  readonly version: string;
  readonly repository: string;
  readonly releaseId: string;
  readonly commit: string;
  readonly evidencePath: string;
}

export interface WindowsVerificationEvidenceUploadRecord {
  readonly status: "existing" | "uploaded";
  readonly tag: string;
  readonly releaseId: string;
  readonly commit: string;
  readonly assetId: number;
  readonly name: string;
  readonly size: number;
  readonly digest: string;
}

export interface WindowsVerificationEvidenceUploadDependencies {
  readonly executeFile?: (
    executable: string,
    arguments_: readonly string[],
  ) => Promise<{ readonly stdout: string }>;
  readonly readFile?: (path: string) => Promise<Buffer>;
  readonly uploadAsset?: (
    uploadUrl: string,
    evidenceName: string,
    bytes: Buffer,
  ) => Promise<unknown>;
  readonly delay?: (milliseconds: number) => Promise<void>;
}

export function safeWindowsVerificationEvidenceMessage(error: unknown): string | undefined;
export function runWindowsVerificationEvidenceUpload(
  input: WindowsVerificationEvidenceUploadInput,
  dependencies?: WindowsVerificationEvidenceUploadDependencies,
): Promise<WindowsVerificationEvidenceUploadRecord>;
