import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", sqlite: "src/sqlite/index.ts", "archive/index": "src/archive/index.ts", "lock/index": "src/lock/index.ts", "store-export/index": "src/store-export/index.ts" },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
});
