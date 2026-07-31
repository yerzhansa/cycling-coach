import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    manual: "src/manual.ts",
    watcher: "src/watcher.ts",
  },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  removeNodeProtocol: false,
});
