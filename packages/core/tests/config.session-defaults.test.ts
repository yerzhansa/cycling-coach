import { describe, it, expect, beforeEach } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify as toYaml } from "yaml";
import { setupConfigEnvSandbox } from "./helpers/config-env-sandbox.js";

const getTempHome = setupConfigEnvSandbox("cc-sessiondefaults-");

const CONFIG = () => join(getTempHome(), ".cycling-coach", "config.yaml");

beforeEach(() => {
  delete process.env.SESSION_DAILY_RESET_HOUR;
  delete process.env.SESSION_IDLE_MINUTES;
  delete process.env.HISTORY_TOKEN_BUDGET_RATIO;
  delete process.env.COACH_TZ;
});

describe("config — session defaults", () => {
  it("resolves all four session defaults with an empty config", async () => {
    const { loadConfig } = await import("../src/config.js");
    const cfg = loadConfig();
    expect(cfg.session.dailyResetHour).toBe(4);
    expect(cfg.session.idleMinutes).toBe(0);
    expect(cfg.session.historyTokenBudgetRatio).toBe(0.3);
    expect(cfg.session.resetArchiveRetentionDays).toBe(0);
    expect(cfg.session.timezone).toBe("");
  });

  it("resolves contextWindowTokens from the default anthropic model", async () => {
    const { loadConfig } = await import("../src/config.js");
    expect(loadConfig().llm.model).toBe("claude-sonnet-4-6");
    expect(loadConfig().contextWindowTokens).toBe(1_000_000);
  });

  it("applies YAML overrides for the four session fields", async () => {
    writeFileSync(
      CONFIG(),
      toYaml({
        session: {
          dailyResetHour: 6,
          idleMinutes: 45,
          historyTokenBudgetRatio: 0.5,
          resetArchiveRetentionDays: 30,
        },
      }),
      { mode: 0o600 },
    );
    const { loadConfig } = await import("../src/config.js");
    const s = loadConfig().session;
    expect(s.dailyResetHour).toBe(6);
    expect(s.idleMinutes).toBe(45);
    expect(s.historyTokenBudgetRatio).toBe(0.5);
    expect(s.resetArchiveRetentionDays).toBe(30);
  });

  it("leaves unspecified session fields at their defaults under a partial YAML", async () => {
    writeFileSync(CONFIG(), toYaml({ session: { dailyResetHour: 9 } }), { mode: 0o600 });
    const { loadConfig } = await import("../src/config.js");
    const s = loadConfig().session;
    expect(s.dailyResetHour).toBe(9);
    expect(s.idleMinutes).toBe(0);
    expect(s.historyTokenBudgetRatio).toBe(0.3);
  });

  it("round-trips the timezone YAML key", async () => {
    writeFileSync(CONFIG(), toYaml({ session: { timezone: "Europe/Berlin" } }), {
      mode: 0o600,
    });
    const { loadConfig } = await import("../src/config.js");
    expect(loadConfig().session.timezone).toBe("Europe/Berlin");
  });
});
