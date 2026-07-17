import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    runtime: "src/runtime.ts",
    sync: "src/sync.ts",
  },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  removeNodeProtocol: false,
});
