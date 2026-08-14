export interface PackagedSecondLaunchResult {
  readonly code: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
}

export function validatePackagedSecondLaunch(
  result: PackagedSecondLaunchResult,
  privateValues: readonly string[],
): PackagedSecondLaunchResult;
