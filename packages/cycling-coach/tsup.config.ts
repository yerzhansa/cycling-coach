import { defineConfig } from "tsup";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateLegalArtifacts } from "./build/legal-artifacts.js";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(packageRoot, "../..");

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  sourcemap: true,
  metafile: true,
  esbuildOptions(options) {
    options.absWorkingDir = repoRoot;
    options.entryPoints = [resolve(packageRoot, "src/index.ts")];
    options.outdir = resolve(packageRoot, "dist");
    options.legalComments = "eof";
  },
  clean: true,
  splitting: false,
  // Bundle @enduragent/* into the binary. The libs are private workspace
  // packages (not published to npm) — bundling makes the published tarball
  // self-contained. See ADR-0010.
  noExternal: [/^@enduragent\//],
  // Shebang for the bin field — npm preserves bin permissions on publish.
  // createRequire shim: bundling @enduragent/* pulls transitive CJS deps
  // (e.g. @grammyjs/auto-retry → debug) inline, and their `require()` of Node
  // builtins hits esbuild's ESM `__require`, which throws without a real
  // `require` in scope. Defining one makes that shim delegate instead of throw.
  banner: {
    js: [
      "#!/usr/bin/env node",
      'import { createRequire as __createRequire } from "node:module";',
      "const require = __createRequire(import.meta.url);",
    ].join("\n"),
  },
  onSuccess: generateLegalArtifacts,
});
