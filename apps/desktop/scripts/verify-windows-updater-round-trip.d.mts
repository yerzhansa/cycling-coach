export interface WindowsUpdaterReleaseInput {
  readonly version: string;
  readonly installer: Uint8Array | { readonly sha512: string; readonly size: number };
  readonly blockmap?: Uint8Array;
  readonly metadata: string | Uint8Array;
}

export interface WindowsUpdaterPreflight {
  readonly feedUrl: string;
  readonly channel: "latest";
  readonly publisherName: string;
  readonly disableWebInstaller: true;
  readonly verifyUpdateCodeSignature: true;
}

export interface WindowsUpdaterRoundTripResult {
  readonly baselineVersion: string;
  readonly candidateVersion: string;
  readonly candidateInstallerName: string;
  readonly candidateInstallerSha512: string;
  readonly candidateInstallerSize: number;
  readonly preflight: WindowsUpdaterPreflight;
  readonly authenticode: "pending-w19";
}

export function verifyWindowsUpdaterRoundTrip(input: {
  readonly baseline: WindowsUpdaterReleaseInput;
  readonly candidate: WindowsUpdaterReleaseInput;
  readonly preflight: WindowsUpdaterPreflight;
}): WindowsUpdaterRoundTripResult;
export function safeWindowsUpdaterRoundTripMessage(error: unknown): string | undefined;
