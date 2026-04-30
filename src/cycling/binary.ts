import type { BinaryConfig } from "@enduragent/core";

export const cyclingBinary: BinaryConfig = {
  binaryName: "cycling-coach",
  displayName: "Cycling Coach",
  dataSubdir: "cycling",
  // Existing macOS Keychain entries are tagged "cycling-coach · *"; per ADR-0006
  // we keep this prefix so installed users see no Keychain Access prompts.
  keychainPrefix: "cycling-coach",
  homeEnvVar: "CYCLING_COACH_HOME",
};
