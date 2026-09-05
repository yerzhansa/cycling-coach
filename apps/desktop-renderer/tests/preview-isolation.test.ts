import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { build, loadConfigFromFile, mergeConfig, type Plugin, type UserConfig } from "vite";
import { describe, expect, it } from "vitest";

const rendererRoot = resolve(import.meta.dirname, "..");
const previewModule = /(?:^|\/)(?:preview|\.storybook)\/|\.stories\.[cm]?[jt]sx?(?:\?|$)/u;

function releaseGuard(): Plugin {
  return {
    name: "verify-release-preview-isolation",
    moduleParsed(module) {
      if (previewModule.test(module.id)) {
        throw new Error(`Release imports preview module: ${module.id}`);
      }
    },
    generateBundle() {
      const modules = [...this.getModuleIds()];
      if (!modules.some((id) => id.endsWith("/src/main.tsx"))) {
        throw new Error("Release graph omitted the production renderer");
      }
      for (const id of modules) {
        if (previewModule.test(id)) throw new Error(`Release imports preview module: ${id}`);
      }
    },
  };
}

async function rendererConfig(kind: "standalone" | "desktop"): Promise<UserConfig> {
  const path =
    kind === "standalone"
      ? resolve(rendererRoot, "vite.config.ts")
      : resolve(rendererRoot, "../desktop/electron.vite.config.ts");
  const loaded = await loadConfigFromFile({ command: "build", mode: "production" }, path);
  if (loaded === null) throw new Error(`Missing release configuration: ${path}`);
  if (kind === "standalone") {
    return mergeConfig(loaded.config, { root: rendererRoot, plugins: [tailwindcss()] });
  }
  const candidate = "renderer" in loaded.config ? loaded.config.renderer : undefined;
  if (typeof candidate !== "object" || candidate === null) {
    throw new Error("Desktop configuration omitted the renderer");
  }
  return mergeConfig(candidate, {});
}

describe("preview release isolation", () => {
  it.each(["standalone", "desktop"] as const)(
    "excludes preview code from the %s release graph",
    async (kind) => {
      const config = await rendererConfig(kind);
      await build(
        mergeConfig(config, {
          configFile: false,
          logLevel: "silent",
          plugins: [releaseGuard()],
          build: { write: false, minify: false, reportCompressedSize: false },
        }),
      );
    },
    60_000,
  );

  it("rejects a transitive preview import even when tree shaking removes it", async () => {
    const injectPreview: Plugin = {
      name: "inject-preview-import-regression",
      enforce: "pre",
      transform(code, id) {
        return id === resolve(rendererRoot, "src/lib/utils.ts")
          ? `import "../../preview/catalogue";\n${code}`
          : null;
      },
    };
    await expect(
      build(
        mergeConfig(await rendererConfig("standalone"), {
          configFile: false,
          logLevel: "silent",
          plugins: [injectPreview, releaseGuard()],
          build: { write: false, minify: false, reportCompressedSize: false },
        }),
      ),
    ).rejects.toThrow("Release imports preview module:");
  }, 60_000);
});
