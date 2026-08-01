import { describe, expect, it, vi } from "vitest";
import type { ClaudeAccountProbeResult } from "@enduragent/core";
import {
  createClaudeCliStatus,
  readClaudeCliSettings,
  type ClaudeCliSettings,
  type ClaudeCliStatusDependencies,
} from "../src/main/claude-cli-status.js";
import {
  DESKTOP_CLAUDE_CLI_RECHECK_CHANNEL,
  DESKTOP_CLAUDE_CLI_STATUS_CHANNEL,
} from "../src/main/onboarding-ipc.js";

const BINARY = "/opt/homebrew/bin/claude";

function settings(overrides: Partial<ClaudeCliSettings> = {}): ClaudeCliSettings {
  return { enabled: true, billing: "subscription", ...overrides };
}

function subscriptionProbe(): ClaudeAccountProbeResult {
  return {
    verified: true,
    accountClass: "subscription",
    email: "athlete@synthetic.test",
    plan: "Max",
  };
}

function harness(input: {
  readonly settings?: ClaudeCliSettings;
  readonly probe?: ClaudeAccountProbeResult;
  readonly binary?: string | null;
  readonly version?: string;
  readonly environment?: Record<string, string | undefined>;
  readonly applyRuntimeConfig?: (request: unknown) => Promise<void>;
}) {
  const resolveBinary = vi.fn(async () => (input.binary === undefined ? BINARY : input.binary));
  const probeVersion = vi.fn(async () => input.version ?? "2.9.0");
  const probeAccount = vi.fn(async () => input.probe ?? subscriptionProbe());
  const invalidateProbeCache = vi.fn();
  const applyRuntimeConfig = vi.fn(input.applyRuntimeConfig ?? (async () => {}));
  const dependencies: ClaudeCliStatusDependencies = {
    resolveBinary,
    probeVersion,
    probeAccount,
    invalidateProbeCache,
  };
  const readSettings = vi.fn(async () => input.settings ?? settings());
  const controller = createClaudeCliStatus({
    settings: readSettings,
    environment: () => input.environment ?? {},
    applyRuntimeConfig,
    dependencies,
  });
  return {
    controller,
    resolveBinary,
    probeVersion,
    probeAccount,
    invalidateProbeCache,
    applyRuntimeConfig,
    readSettings,
  };
}

describe("desktop claude-cli status controller", () => {
  it("reports a verified subscription identity as ready", async () => {
    const subject = harness({});

    await expect(subject.controller.status()).resolves.toEqual({
      state: "ready",
      email: "athlete@synthetic.test",
      plan: "Max",
      version: "2.9.0",
    });
  });

  it("reports probe-confirmed api-key billing as ready-api-key", async () => {
    const subject = harness({
      settings: settings({ billing: "api-key" }),
      probe: { verified: true, accountClass: "api-key-token" },
    });

    await expect(subject.controller.status()).resolves.toEqual({
      state: "ready-api-key",
      version: "2.9.0",
    });
  });

  it.each([
    [
      "an api-key identity in subscription mode",
      { verified: true, accountClass: "api-key-token" } as ClaudeAccountProbeResult,
      "subscription" as const,
      "api-key-token",
    ],
    [
      "an unrecognized auth source",
      {
        verified: false,
        accountClass: "unrecognized",
        rawAuthSource: "synthetic-source",
      } as ClaudeAccountProbeResult,
      "subscription" as const,
      "api-key-token",
    ],
    [
      "an unapproved api key",
      { verified: true, accountClass: "subscription", plan: "Max" } as ClaudeAccountProbeResult,
      "api-key" as const,
      "api-key-token",
    ],
    [
      "a signed-out CLI",
      {
        verified: false,
        accountClass: "not-signed-in",
        reason: "no-account",
      } as ClaudeAccountProbeResult,
      "subscription" as const,
      "not-logged-in",
    ],
    [
      "a probe timeout",
      {
        verified: false,
        accountClass: "unrecognized",
        reason: "timeout",
      } as ClaudeAccountProbeResult,
      "subscription" as const,
      "not-logged-in",
    ],
  ])("refuses %s", async (_case, probe, billing, state) => {
    const subject = harness({ probe, settings: settings({ billing }) });

    await expect(subject.controller.status()).resolves.toEqual({ state });
  });

  it("reports a missing binary as absent-binary", async () => {
    const subject = harness({ binary: null });

    await expect(subject.controller.status()).resolves.toEqual({ state: "absent-binary" });
    expect(subject.probeVersion).not.toHaveBeenCalled();
  });

  it("reports a below-floor CLI version as absent-binary", async () => {
    const subject = harness({ version: "1.0.0" });

    await expect(subject.controller.status()).resolves.toEqual({ state: "absent-binary" });
    expect(subject.probeAccount).not.toHaveBeenCalled();
  });

  it.each([
    ["the environment kill switch", { ENDURAGENT_CLAUDE_CLI_DISABLED: "TRUE" }, settings()],
    ["the configuration flag", {}, settings({ enabled: false })],
  ])("reports %s as disabled without probing", async (_case, environment, current) => {
    const subject = harness({ environment, settings: current });

    await expect(subject.controller.status()).resolves.toEqual({ state: "disabled" });
    expect(subject.resolveBinary).not.toHaveBeenCalled();
    expect(subject.probeAccount).not.toHaveBeenCalled();
  });

  it("re-evaluates eligibility on every status poll", async () => {
    const environment: Record<string, string | undefined> = {};
    const controller = createClaudeCliStatus({
      settings: () => settings(),
      environment: () => environment,
      applyRuntimeConfig: async () => {},
      dependencies: {
        resolveBinary: async () => BINARY,
        probeVersion: async () => "2.9.0",
        probeAccount: async () => subscriptionProbe(),
      },
    });

    await expect(controller.status()).resolves.toMatchObject({ state: "ready" });
    environment.ENDURAGENT_CLAUDE_CLI_DISABLED = "1";
    await expect(controller.status()).resolves.toEqual({ state: "disabled" });
    delete environment.ENDURAGENT_CLAUDE_CLI_DISABLED;
    await expect(controller.status()).resolves.toMatchObject({ state: "ready" });
  });

  it("busts the probe cache on recheck but not on a plain status read", async () => {
    const subject = harness({});

    await subject.controller.status();
    expect(subject.invalidateProbeCache).not.toHaveBeenCalled();

    await expect(subject.controller.recheck()).resolves.toMatchObject({ state: "ready" });
    expect(subject.invalidateProbeCache).toHaveBeenCalledOnce();
  });

  it("busts the probe cache when the settings credentials surface opens", () => {
    const subject = harness({});

    subject.controller.invalidateProbeCache();

    expect(subject.invalidateProbeCache).toHaveBeenCalledOnce();
  });

  it("activates a claude-cli selection once the lane is ready", async () => {
    const subject = harness({});

    await expect(
      subject.controller.activate({
        provider: "claude-cli",
        model: "sonnet",
        endpoint: { mode: "automatic" },
      }),
    ).resolves.toEqual({ status: "configured", runtimeReady: true });
    expect(subject.applyRuntimeConfig).toHaveBeenCalledWith({
      llm: { provider: "claude-cli", model: "sonnet" },
    });
  });

  it.each([
    [
      "a foreign provider",
      { provider: "anthropic", model: "sonnet", endpoint: { mode: "automatic" } },
      "invalid-input",
    ],
    [
      "a custom endpoint",
      {
        provider: "claude-cli",
        model: "sonnet",
        endpoint: { mode: "custom", value: "http://127.0.0.1:1234" },
      },
      "invalid-input",
    ],
  ])("refuses activation for %s", async (_case, selection, reason) => {
    const subject = harness({});

    await expect(subject.controller.activate(selection as never)).resolves.toEqual({
      status: "refused",
      reason,
    });
    expect(subject.applyRuntimeConfig).not.toHaveBeenCalled();
  });

  it("refuses activation while the lane is not signed in", async () => {
    const subject = harness({
      probe: { verified: false, accountClass: "not-signed-in", reason: "no-account" },
    });

    await expect(
      subject.controller.activate({
        provider: "claude-cli",
        model: "sonnet",
        endpoint: { mode: "automatic" },
      }),
    ).resolves.toEqual({ status: "refused", reason: "credential-required" });
    expect(subject.applyRuntimeConfig).not.toHaveBeenCalled();
  });

  it("refuses activation while the lane is disabled", async () => {
    const subject = harness({ settings: settings({ enabled: false }) });

    await expect(
      subject.controller.activate({
        provider: "claude-cli",
        model: "sonnet",
        endpoint: { mode: "automatic" },
      }),
    ).resolves.toEqual({ status: "refused", reason: "runtime-unavailable" });
  });

  it("refuses activation when the runtime rejects the selection", async () => {
    const subject = harness({
      applyRuntimeConfig: async () => {
        throw new TypeError();
      },
    });

    await expect(
      subject.controller.activate({
        provider: "claude-cli",
        model: "sonnet",
        endpoint: { mode: "automatic" },
      }),
    ).resolves.toEqual({ status: "refused", reason: "runtime-unavailable" });
  });
});

describe("desktop claude-cli settings reader", () => {
  it("reads the yaml block and applies the environment overrides", async () => {
    await expect(
      readClaudeCliSettings({
        configPath: "/synthetic/config.yaml",
        environment: { CLAUDE_CLI_PATH: "/synthetic/bin/claude" },
        readConfigFile: async () =>
          [
            "llm:",
            "  provider: claude-cli",
            "  claude_cli:",
            "    enabled: true",
            "    binary_path: /ignored/claude",
            "    config_dir: /synthetic/claude-config",
            "    billing: api-key",
          ].join("\n"),
      }),
    ).resolves.toEqual({
      enabled: true,
      binaryPath: "/synthetic/bin/claude",
      configDir: "/synthetic/claude-config",
      billing: "api-key",
    });
  });

  it("disables the lane when the environment kill switch is set", async () => {
    await expect(
      readClaudeCliSettings({
        configPath: "/synthetic/config.yaml",
        environment: { ENDURAGENT_CLAUDE_CLI_DISABLED: "1" },
        readConfigFile: async () => "llm:\n  claude_cli:\n    enabled: true\n",
      }),
    ).resolves.toEqual({ enabled: false, billing: "subscription" });
  });

  it("falls back to defaults when the configuration file is unreadable", async () => {
    await expect(
      readClaudeCliSettings({
        configPath: "/synthetic/missing.yaml",
        environment: {},
        readConfigFile: async () => {
          throw new Error("ENOENT");
        },
      }),
    ).resolves.toEqual({ enabled: true, billing: "subscription" });
  });
});

describe("desktop claude-cli channels", () => {
  it("pins the onboarding channel names", () => {
    expect(DESKTOP_CLAUDE_CLI_STATUS_CHANNEL).toBe("enduragent:onboarding:claude-cli-status");
    expect(DESKTOP_CLAUDE_CLI_RECHECK_CHANNEL).toBe("enduragent:onboarding:claude-cli-recheck");
  });
});
