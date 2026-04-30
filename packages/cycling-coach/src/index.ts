#!/usr/bin/env node
import { runBinary } from "@enduragent/core";
import { cyclingSport } from "@enduragent/sport-cycling";
import { migrateCyclingLegacySections } from "@enduragent/sport-cycling/migrate";
import { cyclingBinary } from "./binary.js";

await runBinary(cyclingSport, cyclingBinary, {
  onStartup: (memory) => migrateCyclingLegacySections(memory),
});
