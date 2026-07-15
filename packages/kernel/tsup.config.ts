import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    ports: "src/ports/index.ts",
    "store/migrations": "src/store/migrations/index.ts",
    store: "src/store/index.ts",
    "archive/index": "src/archive/index.ts",
    "store/export/index": "src/store/export/index.ts",
    "ingest/index": "src/ingest/index.ts",
  },
  loader: { ".sql": "text" },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
});
