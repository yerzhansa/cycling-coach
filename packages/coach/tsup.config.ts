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
  },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  removeNodeProtocol: false,
});
