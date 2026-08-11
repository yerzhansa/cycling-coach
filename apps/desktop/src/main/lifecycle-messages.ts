import type { DesktopDaemonResolution } from "@enduragent/coach/enduragent";
import type { DesktopDaemonLifecycleState } from "./daemon-lifecycle.js";
import { desktopPlatformProjection } from "./platform-copy.js";

export interface DesktopErrorCopy {
  readonly title: string;
  readonly content: string;
}

export function startupRefusalCopy(
  cause: Extract<DesktopDaemonResolution, { status: "refused" }>["cause"],
  platform: NodeJS.Platform = process.platform,
): DesktopErrorCopy {
  if (cause === "not-configured") {
    return {
      title: "Enduragent isn’t configured",
      content:
        "The configuration file is missing. Run Enduragent setup or restore config.yaml, then reopen Enduragent.",
    };
  }
  if (cause === "unreadable") {
    return {
      title: "Enduragent couldn’t read its configuration",
      content:
        "Check that config.yaml is a readable file and its folder is accessible, then reopen Enduragent.",
    };
  }
  if (cause === "malformed") {
    return {
      title: "Enduragent couldn’t use its configuration",
      content: "Correct or replace the invalid config.yaml file, then reopen Enduragent.",
    };
  }
  if (cause === "contention") {
    return {
      title: "Enduragent couldn’t connect to its background service",
      content:
        "Another Enduragent process is already running or stuck. Quit that process, then reopen Enduragent. If you can’t find it, log out and back in.",
    };
  }
  if (cause === "version-mismatch") {
    return {
      title: "Enduragent found a different background service version",
      content:
        "A different version of the Enduragent background service is running from the CLI or a previous install. Quit that service, then reopen Enduragent.",
    };
  }
  return {
    title: "Enduragent couldn’t start its background service",
    content: `The background service could not start or its saved connection state could not be read. Quit Enduragent and reopen it. If the problem continues, ${desktopPlatformProjection(platform).copy.restartComputer} before trying again.`,
  };
}

export const unexpectedStartupCopy: DesktopErrorCopy = {
  title: "Enduragent couldn’t open",
  content:
    "Enduragent hit an unexpected problem while starting. Quit Enduragent and try again. If it keeps happening, log out and back in before reopening it.",
};

export const restartExhaustedCopy: DesktopErrorCopy = {
  title: "Enduragent’s background service stopped",
  content:
    "The background service stopped repeatedly and Enduragent could not restart it. Quit Enduragent and reopen it. If that does not help, log out and back in.",
};

export function lifecycleErrorCopy(
  state: DesktopDaemonLifecycleState,
): DesktopErrorCopy | undefined {
  if (state.status !== "terminal" || state.cause === "cancelled") return undefined;
  if (state.cause === "restart-exhausted") return restartExhaustedCopy;
  return startupRefusalCopy(state.cause);
}
