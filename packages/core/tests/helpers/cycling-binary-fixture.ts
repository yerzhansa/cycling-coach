import type { BinaryConfig } from "../../src/binary.js";

/**
 * Test fixture mirroring the real `cyclingBinary` declared in
 * `packages/cycling-coach/src/binary.ts`. Defined here as a fixture so Core
 * tests don't need to depend on the cycling-coach binary package (which would
 * create a workspace cycle: core → cycling-coach → core).
 */
export const cyclingBinary: BinaryConfig = {
  binaryName: "cycling-coach",
  displayName: "Cycling Coach",
  dataSubdir: "cycling",
  keychainPrefix: "cycling-coach",
  homeEnvVar: "CYCLING_COACH_HOME",
};
