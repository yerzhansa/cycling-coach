#!/usr/bin/env node
import { runBinary } from "@enduragent/core";
import { cyclingSport } from "./cycling/sport.js";
import { cyclingBinary } from "./cycling/binary.js";
import { migrateCyclingLegacySections } from "./cycling/migrate-legacy-sections.js";

await runBinary(cyclingSport, cyclingBinary, {
  onStartup: (memory) => migrateCyclingLegacySections(memory),
});
