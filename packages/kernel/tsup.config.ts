import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    anchors: "src/anchors/index.ts",
    ports: "src/ports/index.ts",
    "store/migrations": "src/store/migrations/index.ts",
    store: "src/store/index.ts",
    "archive/index": "src/archive/index.ts",
    "store/export/index": "src/store/export/index.ts",
    "ingest/index": "src/ingest/index.ts",
    "reference/metrics": "src/reference/entry/metrics.ts",
    "reference/registry": "src/reference/metrics/registry.ts",
    "reference/schemas": "src/reference/entry/schemas.ts",
    "reference/validation": "src/reference/entry/validation.ts",
    "reference/cs-resolution": "src/reference/cs-resolution.ts",
    "reference/freshness": "src/reference/freshness.ts",
    "reference/preserve-tokens": "src/reference/preserve-tokens.ts",
    "reference/errors": "src/reference/errors.ts",
    "reference/trademark-policy": "src/reference/trademark-policy.ts",
    "reference/capture": "src/reference/capture.ts",
    "reference/capture-once": "src/reference/capture-once.ts",
    "reference/local-bundle": "src/reference/entry/local-bundle.ts",
    concurrency: "src/reference/entry/concurrency.ts",
  },
  loader: { ".sql": "text" },
  external: ["@enduragent/kernel/reference/registry"],
  format: ["esm"],
  dts: {
    compilerOptions: {
      baseUrl: ".",
      paths: { "@enduragent/kernel/reference/registry": ["./src/reference/metrics/registry.ts"] },
    },
  },
  sourcemap: true,
  clean: true,
  splitting: false,
});
