import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  sourcemap: true,
  clean: true,
  splitting: false,
  // Externalize @enduragent/* explicitly. tsup's default already externalizes
  // dependencies, but the explicit regex makes the multi-package dedup
  // contract obvious to a reader.
  external: [/^@enduragent\//],
  // Shebang for the bin field — npm preserves bin permissions on publish.
  banner: { js: "#!/usr/bin/env node" },
});
