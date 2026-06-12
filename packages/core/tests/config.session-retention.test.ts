import { describe, it, expect } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify as toYaml } from "yaml";
import { setupConfigEnvSandbox } from "./helpers/config-env-sandbox.js";

const getTempHome = setupConfigEnvSandbox("cc-sessionretention-");

const CONFIG = () => join(getTempHome(), ".cycling-coach", "config.yaml");

describe("config — session.resetArchiveRetentionDays", () => {
  it("defaults to 0 (archives kept forever)", async () => {
    const { loadConfig } = await import("../src/config.js");
    expect(loadConfig().session.resetArchiveRetentionDays).toBe(0);
  });

  it("resolves the SESSION_RESET_ARCHIVE_RETENTION_DAYS env var", async () => {
    process.env.SESSION_RESET_ARCHIVE_RETENTION_DAYS = "365";
    const { loadConfig } = await import("../src/config.js");
    expect(loadConfig().session.resetArchiveRetentionDays).toBe(365);
  });

  it("resolves the yaml session.resetArchiveRetentionDays key", async () => {
    writeFileSync(CONFIG(), toYaml({ session: { resetArchiveRetentionDays: 30 } }), {
      mode: 0o600,
    });
    const { loadConfig } = await import("../src/config.js");
    expect(loadConfig().session.resetArchiveRetentionDays).toBe(30);
  });
});
