import { describe, it, expect } from "vitest";
import { binaryEnvVar } from "../src/binary.js";

describe("binaryEnvVar", () => {
  it("derives the historical cycling-coach literals byte-for-byte", () => {
    expect(binaryEnvVar("cycling-coach", "NO_UPDATE_CHECK")).toBe("CYCLING_COACH_NO_UPDATE_CHECK");
    expect(binaryEnvVar("cycling-coach", "MANAGED_DEPLOY")).toBe("CYCLING_COACH_MANAGED_DEPLOY");
    expect(binaryEnvVar("cycling-coach", "SETUP_CAPTURE_TIMEOUT_MS")).toBe(
      "CYCLING_COACH_SETUP_CAPTURE_TIMEOUT_MS",
    );
    expect(binaryEnvVar("cycling-coach", "CAPTURE_CONFIRM_TIMEOUT_MS")).toBe(
      "CYCLING_COACH_CAPTURE_CONFIRM_TIMEOUT_MS",
    );
  });

  it("derives per-binary names for other binaries", () => {
    expect(binaryEnvVar("running-coach", "SETUP_CAPTURE_TIMEOUT_MS")).toBe(
      "RUNNING_COACH_SETUP_CAPTURE_TIMEOUT_MS",
    );
    expect(binaryEnvVar("duathlon-coach", "MANAGED_DEPLOY")).toBe("DUATHLON_COACH_MANAGED_DEPLOY");
  });

  it("uppercases and replaces every hyphen with an underscore", () => {
    expect(binaryEnvVar("a-b-c", "X")).toBe("A_B_C_X");
  });
});
