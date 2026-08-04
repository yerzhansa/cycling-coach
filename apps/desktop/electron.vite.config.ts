import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { appVersionDefine } from "../desktop-renderer/app-version.mjs";

const desktopRoot = import.meta.dirname;

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(desktopRoot, "src/main/index.ts"),
          "daemon-utility": resolve(desktopRoot, "src/utility/daemon.ts"),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve(desktopRoot, "src/preload/index.ts"),
        output: { format: "cjs", entryFileNames: "index.cjs" },
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
      outDir: resolve(desktopRoot, "out/renderer"),
      emptyOutDir: true,
      rollupOptions: {
        input: {
          index: resolve(desktopRoot, "../desktop-renderer/index.html"),
          tray: resolve(desktopRoot, "../desktop-renderer/tray.html"),
        },
      },
    },
  },
});
