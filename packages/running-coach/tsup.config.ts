import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  sourcemap: true,
  clean: true,
  splitting: false,
  // Externalize @enduragent/* explicitly: running-coach is a private, unpublished
  // workspace package, so Core and sport-running resolve through pnpm symlinks at
  // runtime instead of being bundled. Flip to noExternal when it goes public (the
  // publish smoke test enforces this); tsup's default already externalizes deps —
  // the regex just pins the contract.
  external: [/^@enduragent\//],
  // Shebang for the bin field — npm preserves bin permissions on publish.
  banner: { js: "#!/usr/bin/env node" },
});
