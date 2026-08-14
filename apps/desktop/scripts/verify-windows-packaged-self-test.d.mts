export interface PackagedSecondLaunchResult {
  readonly code: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ProcessExitSource {
  once(event: "error", listener: (error: Error) => void): unknown;
  once(
    event: "exit",
    listener: (code: number | null, signal: string | null) => void,
  ): unknown;
}

export interface ProcessExitResult {
  readonly code: number | null;
  readonly signal: string | null;
}

export function observeProcessExit(child: ProcessExitSource): Promise<ProcessExitResult>;

export interface WindowsScratchRemoveOptions {
  readonly recursive: true;
  readonly force: true;
  readonly maxRetries: 10;
  readonly retryDelay: 100;
}

export function removeWindowsScratch(
  path: string,
  remove?: (path: string, options: WindowsScratchRemoveOptions) => Promise<void>,
): Promise<void>;

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
