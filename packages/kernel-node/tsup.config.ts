import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", sqlite: "src/sqlite/index.ts" },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
});
