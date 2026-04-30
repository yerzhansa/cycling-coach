import { defineConfig } from "vitest/config";

/**
 * Vite (which vitest is built on) doesn't natively handle `import x from "*.md"`
 * as raw text — that's an esbuild/tsup-specific loader. This plugin mirrors the
 * tsup `loader: { ".md": "text" }` behavior at test time so sport.ts's
 * `import soul from "../SOUL.md"` and skills.generated.ts's markdown imports
 * resolve to inline default-export strings during vitest runs.
 */
export default defineConfig({
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
