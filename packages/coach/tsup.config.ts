import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    runtime: "src/runtime.ts",
    sync: "src/sync.ts",
    backfill: "src/backfill.ts",
    "backfill-benchmark": "src/backfill-benchmark.ts",
    "backfill-command": "src/backfill-command.ts",
    capture: "src/capture.ts",
    "capture-command": "src/capture-command.ts",
    "reference-capture-command": "src/reference-capture-command.ts",
    "local-bundle-producer": "src/local-bundle-producer.ts",
    "store-runtime": "src/store-runtime.ts",
    "local-bot": "src/local-bot.ts",
    "soak-record": "src/soak-record.ts",
    "store-gate-command": "src/store-gate-command.ts",
    "season-review-command": "src/season-review-command.ts",
    "local-runner": "src/local-runner.ts",
    enduragent: "src/enduragent.ts",
  },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  removeNodeProtocol: false,
});
