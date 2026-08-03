export interface SecuritySmokeEnvironment {
  readonly scratchRoot: string;
  readonly athleteHome: string;
  readonly configDirectory: string;
  readonly operatorHome: string;
  readonly electronUserData: string;
  readonly outputDirectory: string | undefined;
  readonly screenshotDirectory: string;
  readonly screenshotPath: string;
  readonly launchEnvironment: Readonly<{
    HOME: string;
    ENDURAGENT_HOME: string;
    FORCE_COLOR: undefined;
    CLICOLOR_FORCE: undefined;
  }>;
  readonly extraArguments: readonly [string, string];
}

export function createElectronLaunchArguments(
  mode: "development" | "packaged",
  desktopRoot: string,
  flag: string,
  extraArguments?: readonly string[],
): string[];

export function createSecuritySmokeEnvironment(
  scratchRoot: string,
  outputDirectory?: string,
): SecuritySmokeEnvironment;

export function createSecuritySmokeLaunchEnvironment(
  sourceEnvironment: Readonly<Record<string, string | undefined>>,
  securityEnvironment: Pick<SecuritySmokeEnvironment, "launchEnvironment">,
  platform: NodeJS.Platform,
): Record<string, string | undefined>;

export function cleanupSecuritySmokeEnvironment(
  environment: Pick<SecuritySmokeEnvironment, "scratchRoot">,
): Promise<void>;
