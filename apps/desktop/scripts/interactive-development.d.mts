export interface InteractiveDevelopmentPlanInput {
  readonly platform: NodeJS.Platform;
  readonly desktopRoot: string;
  readonly scratchRoot: string;
  readonly nodeExecutable: string;
  readonly packageManagerScript: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
}

export const DESKTOP_INSPECTION_FIXTURE_ENV: "ENDURAGENT_DESKTOP_INSPECTION_FIXTURE";
export const PLAN_CURRENT_INSPECTION_FIXTURE: "plan-current";

export interface InteractiveDevelopmentPlan {
  readonly command: "/usr/bin/caffeinate";
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly scratchRoot: string;
  readonly athleteHome: string;
  readonly userData: string;
}

export function createInteractiveDevelopmentPlan(
  input: InteractiveDevelopmentPlanInput,
): InteractiveDevelopmentPlan;

export function selectInteractiveDevelopmentTemporaryRoot(
  platform: NodeJS.Platform,
  configuredRoot?: string,
): string;

export function runInteractiveDevelopment(
  input?: Readonly<{
    platform?: NodeJS.Platform;
    desktopRoot?: string;
    temporaryRoot?: string;
    nodeExecutable?: string;
    packageManagerScript?: string;
    environment?: Readonly<Record<string, string | undefined>>;
  }>,
  dependencies?: Readonly<Record<string, unknown>>,
): Promise<number>;
