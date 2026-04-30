import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", migrate: "src/migrate.ts" },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  // Raw-text loader so `import soul from "../SOUL.md"` and skills.generated.ts's
  // markdown imports inline the content into the bundle — installed packages
  // don't need filesystem access at runtime.
  loader: { ".md": "text" },
});
