import { resolve } from "node:path";
import { defineConfig } from "electron-vite";

const output = process.env.RESIDENCY_FIXTURE_STAGE;
if (output === undefined) throw new TypeError();

export default defineConfig({
  main: {
    build: {
      outDir: output,
      emptyOutDir: false,
      rollupOptions: {
        input: resolve(process.cwd(), "tests", "fixtures", "residency", "main.ts"),
        output: { format: "cjs", entryFileNames: "main.cjs" },
      },
    },
  },
});
