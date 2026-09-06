import type { ServiceRegistrationState } from "@enduragent/coach-cli";
import type { AthleteHome } from "@enduragent/kernel-node/home";
import type { LaunchdServiceStatus } from "@enduragent/kernel-node/service";

export interface DesktopRegistrationInput {
  readonly platform: NodeJS.Platform;
  readonly home: AthleteHome;
  readonly executablePath: string;
}

export type DesktopRegistrationResult =
  | {
      readonly source: "launchd";
      readonly registration: ServiceRegistrationState;
      readonly status: LaunchdServiceStatus;
    }
  | {
      readonly source: "app-supervised";
      readonly registration: "absent";
    }
  | {
      readonly source: "override";
      readonly registration: ServiceRegistrationState;
    };

export interface DesktopRegistrationDependencies {
  readonly readServiceStatus: (input: {
    readonly home: AthleteHome;
    readonly executablePath: string;
  }) => Promise<LaunchdServiceStatus>;
  readonly serviceRegistrationState?: () => Promise<ServiceRegistrationState>;
}

export async function readDesktopRegistration(
  input: DesktopRegistrationInput,
  dependencies: DesktopRegistrationDependencies,
): Promise<DesktopRegistrationResult> {
  if (input.platform === "win32") {
    return { source: "app-supervised", registration: "absent" };
  }
  if (dependencies.serviceRegistrationState !== undefined) {
    return {
      source: "override",
      registration: await dependencies.serviceRegistrationState(),
    };
  }
  if (input.platform !== "darwin") {
    return { source: "app-supervised", registration: "absent" };
  }
  const status = await dependencies.readServiceStatus({
    home: input.home,
    executablePath: input.executablePath,
  });
  return {
    source: "launchd",
    registration: status.kind === "registered" ? "present" : status.kind,
    status,
  };
}
