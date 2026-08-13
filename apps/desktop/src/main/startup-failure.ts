import { createSubsystemLogger } from "@enduragent/core";
import { resolveDesktopAthleteHome } from "./first-run-config.js";

export function logDesktopStartupFailure(
  error: unknown,
  dataDir = resolveDesktopAthleteHome(),
): void {
  createSubsystemLogger("desktop", dataDir).error("startup_failed", error);
}
