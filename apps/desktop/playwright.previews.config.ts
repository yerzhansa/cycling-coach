import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";
import baseline from "./tests/e2e/previews/baseline.json" with { type: "json" };

export default defineConfig({
  testDir: "./tests/e2e/previews",
  testMatch: "**/*.spec.ts",
  globalSetup: "./tests/e2e/previews/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  webServer: {
    command:
      "pnpm exec vite preview --outDir dist-storybook --host 127.0.0.1 --port 5187 --strictPort",
    cwd: resolve(import.meta.dirname, "../desktop-renderer"),
    url: "http://127.0.0.1:5187/index.json",
    reuseExistingServer: false,
  },
  timeout: 30_000,
  outputDir: "./test-results/previews",
  reporter: [["list"], ["json", { outputFile: "./test-results/previews/report.json" }]],
  expect: { toHaveScreenshot: { animations: "disabled", caret: "hide", maxDiffPixels: 0 } },
  snapshotPathTemplate: `{testDir}/baselines/${baseline.version}/{projectName}/{arg}{ext}`,
  updateSnapshots: "none",
  use: {
    baseURL: "http://127.0.0.1:5187",
    browserName: "chromium",
    locale: "en-US",
    timezoneId: "UTC",
    deviceScaleFactor: 1,
    contextOptions: { reducedMotion: "reduce" },
    serviceWorkers: "block",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "wide-light", use: { viewport: { width: 1180, height: 820 }, colorScheme: "light" } },
    { name: "wide-dark", use: { viewport: { width: 1180, height: 820 }, colorScheme: "dark" } },
    { name: "compact-light", use: { viewport: { width: 760, height: 760 }, colorScheme: "light" } },
    { name: "compact-dark", use: { viewport: { width: 760, height: 760 }, colorScheme: "dark" } },
  ],
});
