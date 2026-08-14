export interface PackagedSecondLaunchResult {
  readonly code: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface PackagedSelfTestTerminal {
  readonly type: "self-test-terminal";
  readonly ok: true;
  readonly runtime: {
    readonly node: string;
    readonly electron: "43.1.1";
  };
  readonly suites: {
    readonly parity: { readonly cases: number; readonly passed: number };
    readonly differential: { readonly cases: number; readonly passed: number };
  };
}

export function validateSelfTestTerminal(value: unknown): PackagedSelfTestTerminal;

export function validatePackagedSecondLaunch(
  result: PackagedSecondLaunchResult,
  privateValues: readonly string[],
): PackagedSecondLaunchResult;
