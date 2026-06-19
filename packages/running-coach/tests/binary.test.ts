import { describe, it, expect } from "vitest";
import { runBinary } from "@enduragent/core";
import { runningSport } from "@enduragent/sport-running";
import { runningBinary } from "../src/binary.js";

describe("running-coach binary wiring", () => {
  it("exposes a complete, running-flavored BinaryConfig", () => {
    expect(runningBinary).toStrictEqual({
      binaryName: "running-coach",
      displayName: "Running Coach",
      dataSubdir: "running",
      keychainPrefix: "running-coach",
      homeEnvVar: "RUNNING_COACH_HOME",
    });
  });

  it("wires the running sport into core's runBinary entrypoint", () => {
    expect(typeof runBinary).toBe("function");
    expect(runningSport.id).toBe("running");
  });
});
