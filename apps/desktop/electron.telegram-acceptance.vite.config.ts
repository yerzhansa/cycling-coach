import { resolve } from "node:path";
import { defineConfig, mergeConfig } from "electron-vite";
import { createDesktopViteConfig } from "./electron.vite.config.js";

const desktopRoot = import.meta.dirname;

const base = createDesktopViteConfig({
  outputRoot: resolve(desktopRoot, "dist/telegram-acceptance-build/out"),
  daemonUtilityEntry: resolve(desktopRoot, "tests/fixtures/packaged-telegram/daemon-utility.ts"),
});

export default defineConfig(
  mergeConfig(base, {
    main: {
      build: {
        rollupOptions: {
          input: {
            index: resolve(desktopRoot, "tests/fixtures/packaged-telegram/main-entry.ts"),
          },
        },
      },
    },
  }),
);
