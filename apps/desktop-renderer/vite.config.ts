import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { configDefaults } from "vitest/config";

const rendererRoot = import.meta.dirname;

export default defineConfig({
  plugins: [react()],
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
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "renderer",
          environment: "node",
          exclude: [...configDefaults.exclude, "tests/**/*.test.tsx"],
        },
      },
      {
        extends: true,
        test: {
          name: "renderer-dom",
          environment: "jsdom",
          include: ["tests/**/*.test.tsx"],
          setupFiles: ["tests/dom-setup.ts"],
        },
      },
    ],
  },
});
