import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", sqlite: "src/sqlite/index.ts", "archive/index": "src/archive/index.ts", "lock/index": "src/lock/index.ts", "store-export/index": "src/store-export/index.ts", "home/index": "src/home/index.ts", "filesystem/index": "src/filesystem/index.ts", "ingest/index": "src/ingest/index.ts", "capture-manifest/index": "src/capture-manifest/index.ts", "service/index": "src/service/index.ts", "planning/index": "src/planning/index.ts", "coach-dev": "src/cli/coach-dev.ts" },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  removeNodeProtocol: false,
});
