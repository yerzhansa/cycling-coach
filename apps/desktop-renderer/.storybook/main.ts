import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import type { StorybookConfig } from "@storybook/react-vite";
import { mergeConfig } from "vite";
import { previewSourceIdentity } from "../preview-identity";

const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const dirty =
  execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim().length > 0;

const config: StorybookConfig = {
  stories: ["../preview/**/*.stories.tsx"],
  addons: ["@storybook/addon-docs"],
  framework: "@storybook/react-vite",
  core: { disableTelemetry: true },
  viteFinal: (config) =>
    mergeConfig(config, {
      plugins: [previewSourceIdentity({ root: resolve(import.meta.dirname, "..") })],
      define: {
        __PREVIEW_REVISION__: JSON.stringify(`${revision}${dirty ? " + working changes" : ""}`),
      },
      server: { host: "127.0.0.1" },
    }),
};

export default config;
