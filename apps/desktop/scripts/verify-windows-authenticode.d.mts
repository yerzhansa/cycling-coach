export interface WindowsAuthenticodeCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface WindowsAuthenticodeSigner {
  readonly subject: string;
  readonly thumbprint: string;
  readonly issuer: string;
  readonly notAfter: string;
}

export interface WindowsAuthenticodeSummary {
  readonly schema: "windows-authenticode-verification/1";
  readonly installerPath: string;
  readonly ok: boolean;
  readonly signer: WindowsAuthenticodeSigner | null;
  readonly timestamper: { readonly subject: string } | null;
  readonly status: string | null;
  readonly statusMessage: string | null;
  readonly digestAlgorithm: string | null;
  readonly rfc3161: boolean;
  readonly signtool: {
    readonly path: string | null;
    readonly exitCode: number | null;
    readonly output: string;
  };
  readonly allowSelfSignedTest: boolean;
  readonly checks: readonly WindowsAuthenticodeCheck[];
}

export interface WindowsAuthenticodeOptions {
  readonly installerPath: string;
  readonly expectedPublisherDn: string;
  readonly expectedThumbprint?: string;
  readonly allowSelfSignedTest?: boolean;
  readonly allowMissingSigntool?: boolean;
}

export interface WindowsAuthenticodeDependencies {
  readonly executeFile?: (
    executable: string,
    arguments_: readonly string[],
    options: { readonly encoding: "utf8"; readonly maxBuffer: number },
  ) => Promise<unknown>;
  readonly scriptPath?: string;
}

export interface VerifiedWindowsAuthenticode {
  readonly ok: true;
  readonly signer: WindowsAuthenticodeSigner;
  readonly digestAlgorithm: "sha256";
  readonly rfc3161: true;
}

export interface WindowsAuthenticodeVerifyMode {
  readonly mode: "verify";
  readonly expectedPublisherDn: string;
  readonly verify: (
    installerPath: string,
    context: { readonly version: string; readonly publisherName?: string },
  ) => Promise<void>;
}

export const WINDOWS_AUTHENTICODE_SUMMARY_SCHEMA: "windows-authenticode-verification/1";
export const WINDOWS_AUTHENTICODE_REQUIRED_CHECKS: readonly [
  "file",
  "status",
  "digest",
  "timestamp",
  "subject",
  "chain",
  "signtool",
];
export function parseWindowsAuthenticodeSummary(stdout: string): WindowsAuthenticodeSummary;
export function decideWindowsAuthenticode(
  summary: WindowsAuthenticodeSummary,
  options: Pick<WindowsAuthenticodeOptions, "expectedPublisherDn" | "expectedThumbprint" | "allowSelfSignedTest">,
): VerifiedWindowsAuthenticode;
export function verifyWindowsAuthenticode(
  options: WindowsAuthenticodeOptions,
  dependencies?: WindowsAuthenticodeDependencies,
): Promise<VerifiedWindowsAuthenticode>;
export function createWindowsAuthenticodeVerifyMode(
  options: Omit<WindowsAuthenticodeOptions, "installerPath">,
  dependencies?: WindowsAuthenticodeDependencies,
): WindowsAuthenticodeVerifyMode;
export function safeWindowsAuthenticodeMessage(error: unknown): string | undefined;
