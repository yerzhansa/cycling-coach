import { fileURLToPath } from "node:url";
import { configDefaults, coverageConfigDefaults, defineConfig } from "vitest/config";

/**
 * Vite (which vitest is built on) doesn't natively handle `import x from "*.md"`
 * as raw text — that's an esbuild/tsup-specific loader used at build time. These
 * plugins mirror the tsup `loader: { ".md": "text" }` behavior at test time so
 * sport packages' `import soul from "../SOUL.md"` and skills.generated.ts's
 * markdown imports resolve to inline default-export strings during vitest runs.
 */
const rawAssetPlugins = [
  {
    name: "raw-md",
    enforce: "pre" as const,
    transform(code: string, id: string) {
      if (id.endsWith(".md")) {
        return { code: `export default ${JSON.stringify(code)};`, map: null };
      }
      return null;
    },
  },
  {
    name: "raw-sql",
    enforce: "pre" as const,
    transform(code: string, id: string) {
      if (id.endsWith(".sql")) {
        return { code: `export default ${JSON.stringify(code)};`, map: null };
      }
      return null;
    },
  },
];

/**
 * Two projects, one environment each. The desktop renderer's React component
 * tests need a DOM; every other test in the workspace runs on plain Node and
 * must keep doing so, and vitest 4 removed the per-file `environmentMatchGlobs`
 * escape hatch that used to express that split in one project.
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
      include: ["packages/*/src/**/*.ts", "apps/*/src/**/*.ts"],
      exclude: [
        ...(coverageConfigDefaults.exclude ?? []),
        "**/*.test.ts",
        "**/*.generated.ts",
        "**/index.ts",
      ],
    },
    projects: [
      {
        plugins: rawAssetPlugins,
        test: {
          name: "workspace",
          pool: "forks",
          isolate: true,
          environment: "node",
          exclude: [...configDefaults.exclude, "**/.claude/**", "**/*.test.tsx"],
        },
      },
      {
        root: fileURLToPath(new URL("apps/desktop-renderer", import.meta.url)),
        test: {
          name: "renderer-dom",
          pool: "forks",
          isolate: true,
          environment: "jsdom",
          include: ["tests/**/*.test.tsx"],
          setupFiles: ["tests/dom-setup.ts"],
        },
      },
    ],
  },
  plugins: rawAssetPlugins,
});
