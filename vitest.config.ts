import { configDefaults, coverageConfigDefaults, defineConfig } from "vitest/config";

/**
 * Vite (which vitest is built on) doesn't natively handle `import x from "*.md"`
 * as raw text — that's an esbuild/tsup-specific loader used at build time. This
 * plugin mirrors the tsup `loader: { ".md": "text" }` behavior at test time so
 * sport packages' `import soul from "../SOUL.md"` and skills.generated.ts's
 * markdown imports resolve to inline default-export strings during vitest runs.
 */
export default defineConfig({
  test: {
    // Pinned (not relying on vitest defaults): the parallel-safety contract —
    // per-file isolation + process-level forks — is what every mkdtemp fixture
    // and module-singleton reset seam depends on; a vitest-major default flip
    // to shared-globals `threads` would silently break it.
    pool: "forks",
    isolate: true,
    exclude: [...configDefaults.exclude, "**/.claude/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      reportsDirectory: "./coverage",
      include: ["packages/*/src/**/*.ts"],
      exclude: [
        ...(coverageConfigDefaults.exclude ?? []),
        "**/*.test.ts",
        "**/*.generated.ts",
        "**/index.ts",
      ],
    },
  },
  plugins: [
    {
      name: "raw-md",
      enforce: "pre",
      transform(code, id) {
        if (id.endsWith(".md")) {
          return { code: `export default ${JSON.stringify(code)};`, map: null };
        }
        return null;
      },
    },
  ],
});
