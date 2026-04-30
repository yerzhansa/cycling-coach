import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", migrate: "src/migrate.ts" },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
});
