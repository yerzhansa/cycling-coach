import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  sourcemap: true,
  clean: true,
  splitting: false,
  // Bundle @enduragent/* into the binary. The libs are private workspace
  // packages (not published to npm) — bundling makes the published tarball
  // self-contained. See ADR-0010.
  noExternal: [/^@enduragent\//],
  // Shebang for the bin field — npm preserves bin permissions on publish.
  banner: { js: "#!/usr/bin/env node" },
});
