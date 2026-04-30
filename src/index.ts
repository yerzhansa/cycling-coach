#!/usr/bin/env node
import { runBinary } from "@enduragent/core";
import { cyclingSport, cyclingBinary } from "@enduragent/sport-cycling";
import { migrateCyclingLegacySections } from "@enduragent/sport-cycling/migrate";

await runBinary(cyclingSport, cyclingBinary, {
  onStartup: (memory) => migrateCyclingLegacySections(memory),
});
