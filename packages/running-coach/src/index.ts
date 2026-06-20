import { runBinary, reportFatal, getCoachHome } from "@enduragent/core";
import { runningSport } from "@enduragent/sport-running";
import { runningBinary } from "./binary.js";

try {
  await runBinary(runningSport, runningBinary);
} catch (err) {
  reportFatal(err, { dataDir: getCoachHome(runningBinary.binaryName) });
}
