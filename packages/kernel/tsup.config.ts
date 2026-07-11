import { defineConfig } from "tsup";

export default defineConfig({
  entry: { ports: "src/ports/index.ts" },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
});
