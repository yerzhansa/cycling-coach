import { resolve } from "node:path";
import { defineConfig } from "vite";

const rendererRoot = import.meta.dirname;

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(rendererRoot, "index.html"),
        tray: resolve(rendererRoot, "tray.html"),
      },
    },
  },
});
