import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin, type UserConfig } from "electron-vite";
import { appVersionDefine } from "../desktop-renderer/app-version.mjs";

const desktopRoot = import.meta.dirname;

export function createDesktopViteConfig(
  options: {
    readonly outputRoot?: string;
    readonly daemonUtilityEntry?: string;
  } = {},
): UserConfig {
  const outputRoot = options.outputRoot ?? resolve(desktopRoot, "out");
  const daemonUtilityEntry =
    options.daemonUtilityEntry ?? resolve(desktopRoot, "src/utility/daemon.ts");

  return {
    main: {
      plugins: [externalizeDepsPlugin()],
      build: {
        outDir: resolve(outputRoot, "main"),
        rollupOptions: {
          input: {
            index: resolve(desktopRoot, "src/main/index.ts"),
            "daemon-utility": daemonUtilityEntry,
          },
        },
      },
    },
    preload: {
      plugins: [externalizeDepsPlugin({ exclude: ["@enduragent/coach-contract"] })],
      build: {
        outDir: resolve(outputRoot, "preload"),
        rollupOptions: {
          input: {
            index: resolve(desktopRoot, "src/preload/index.ts"),
            tray: resolve(desktopRoot, "src/preload/tray.ts"),
          },
          output: { format: "cjs", entryFileNames: "[name].cjs" },
        },
      },
    },
    renderer: {
      root: resolve(desktopRoot, "../desktop-renderer"),
      plugins: [react(), tailwindcss()],
      define: appVersionDefine(),
      optimizeDeps: { include: ["lucide-react"] },
      server: {
        host: "127.0.0.1",
        port: 5173,
        strictPort: true,
        hmr: { protocol: "ws", host: "127.0.0.1", port: 5173 },
      },
      build: {
        outDir: resolve(outputRoot, "renderer"),
        emptyOutDir: true,
        rollupOptions: {
          input: {
            index: resolve(desktopRoot, "../desktop-renderer/index.html"),
            tray: resolve(desktopRoot, "../desktop-renderer/tray.html"),
          },
        },
      },
    },
  };
}

export default defineConfig(createDesktopViteConfig());
