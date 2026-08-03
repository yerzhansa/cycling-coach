import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { OnboardingBridge, OnboardingLlmConfiguration } from "../src/onboarding/bridge.js";
import type { ClaudeCliStatus } from "../src/onboarding/machine.js";
import {
  control,
  credentialBadges,
  mountWizard,
  resetOnboardingStore,
  testBridge,
  type TestBridge,
} from "./onboarding-harness.js";

const CLAUDE_CLI_CONFIGURATION: OnboardingLlmConfiguration = {
  schemaVersion: 1,
  providers: [
    {
      provider: "anthropic",
      defaultModel: "claude-sonnet-4-6",
      models: [{ value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" }],
    },
    {
      provider: "claude-cli",
      defaultModel: "sonnet",
      models: [{ value: "sonnet", label: "Claude Sonnet" }],
    },
  ],
  active: null,
};

const ACTIVE_CLAUDE_CLI_CONFIGURATION: OnboardingLlmConfiguration = {
  ...CLAUDE_CLI_CONFIGURATION,
  active: { provider: "claude-cli", model: "sonnet" },
};

function claudeBridge(status: ClaudeCliStatus, overrides: Partial<OnboardingBridge> = {}) {
  const bridge: TestBridge = testBridge(async () => ({
    status: "refused",
    reason: "cancelled",
  }));
  bridge.chatGptStatus.mockResolvedValue({ state: "absent", runtimeReady: false });
  bridge.llmConfiguration.mockResolvedValue(CLAUDE_CLI_CONFIGURATION);
  bridge.claudeCliStatus.mockResolvedValue(status);
  bridge.claudeCliRecheck.mockResolvedValue(status);
  return Object.assign(bridge, overrides);
}

function laneBadge(): HTMLElement {
  const badge = document.querySelector<HTMLElement>(".claude-cli-state");
  if (badge === null) throw new Error("Claude subscription badge not found");
  return badge;
}

function identityLine(): string | null {
  return document.querySelector<HTMLElement>("[data-claude-cli-identity]")?.textContent ?? null;
}

async function openLane(bridge: TestBridge): Promise<ReturnType<typeof mountWizard>> {
  const wizard = mountWizard({ bridge });
  await wizard.open();
  await waitFor(() => {
    expect(bridge.claudeCliStatus).toHaveBeenCalled();
    expect(laneBadge().textContent).not.toBe("Checking");
  });
  return wizard;
}

describe("claude-cli onboarding lane", () => {
  afterEach(() => {
    resetOnboardingStore();
  });

  it("opens the wizard before the account probe answers", async () => {
    let settle: ((status: ClaudeCliStatus) => void) | undefined;
    const bridge = claudeBridge({ state: "ready" });
    bridge.claudeCliStatus.mockReturnValue(
      new Promise<ClaudeCliStatus>((resolve) => {
        settle = resolve;
      }),
    );
    const wizard = mountWizard({ bridge });

    await wizard.open();

    expect(screen.getByRole("heading", { name: "Choose how your coach thinks" })).toBeDefined();
    expect(laneBadge().textContent).toBe("Checking");
    expect(identityLine()).toBeNull();
    expect(document.body.textContent).toContain("Checking the Claude Code CLI sign-in on this Mac");

    await act(async () => {
      settle?.({ state: "ready", email: "athlete@example.test", plan: "Max" });
    });

    await waitFor(() => {
      expect(identityLine()).toBe("Signed in as athlete@example.test - Claude Max subscription");
    });
    wizard.controller.dispose();
  });

  it("renders the signed-in identity with the plan and email from the probe", async () => {
    const wizard = await openLane(
      claudeBridge({
        state: "ready",
        email: "athlete@example.test",
        plan: "Max",
        version: "2.1.0",
      }),
    );

    expect(identityLine()).toBe("Signed in as athlete@example.test - Claude Max subscription");
    expect(laneBadge().textContent).toBe("Signed in");
    expect(laneBadge().dataset.state).toBe("configured");
    expect(document.body.textContent).not.toContain("undefined");
    wizard.controller.dispose();
  });

  it("falls back to the email alone when the probe reports no plan", async () => {
    const wizard = await openLane(claudeBridge({ state: "ready", email: "athlete@example.test" }));

    expect(identityLine()).toBe("Signed in as athlete@example.test");
    expect(document.body.textContent).not.toContain("Claude undefined subscription");
    wizard.controller.dispose();
  });

  it("keeps the plan when the email is unavailable", async () => {
    const wizard = await openLane(claudeBridge({ state: "ready", plan: "Pro" }));

    expect(identityLine()).toBe("Signed in - Claude Pro subscription");
    wizard.controller.dispose();
  });

  it("names API key billing instead of claiming a subscription", async () => {
    const wizard = await openLane(claudeBridge({ state: "ready-api-key" }));

    expect(identityLine()).toBe(
      "Using Anthropic API key billing - usage is charged to your API account.",
    );
    expect(identityLine()).not.toContain("subscription");
    expect(laneBadge().textContent).toBe("API key billing");
    wizard.controller.dispose();
  });

  it("guides a signed-out athlete to sign in from their own terminal", async () => {
    const wizard = await openLane(claudeBridge({ state: "not-logged-in" }));

    expect(identityLine()).toBeNull();
    expect(document.body.textContent).toContain(
      "Claude Code CLI is not signed in. Open a terminal, run claude, and sign in with your Claude subscription. Enduragent never signs in for you.",
    );
    expect(laneBadge().dataset.state).toBe("failed");
    wizard.controller.dispose();
  });

  it("reports a missing binary and an api-key token distinctly", async () => {
    const absent = await openLane(claudeBridge({ state: "absent-binary" }));
    expect(document.body.textContent).toContain("Claude Code CLI was not found");
    absent.controller.dispose();
    absent.rendered.unmount();
    resetOnboardingStore();

    const apiKeyToken = await openLane(claudeBridge({ state: "api-key-token" }));
    expect(document.body.textContent).toContain(
      "Claude Code CLI is authenticated with an API key or token, not a subscription.",
    );
    expect(laneBadge().textContent).toBe("API key, not a subscription");
    apiKeyToken.controller.dispose();
  });

  it("renders the kill switch as a turned-off lane", async () => {
    const wizard = await openLane(claudeBridge({ state: "disabled" }));

    expect(document.body.textContent).toContain(
      "The Claude subscription lane is turned off on this Mac. Choose another provider.",
    );
    expect(laneBadge().textContent).toBe("Turned off");
    expect(laneBadge().dataset.state).toBe("stored-inactive");
    expect(identityLine()).toBeNull();
    wizard.controller.dispose();
  });

  it("rechecks the account on demand and never shows a credential field for the lane", async () => {
    const user = userEvent.setup();
    const bridge = claudeBridge({ state: "not-logged-in" });
    bridge.claudeCliRecheck.mockResolvedValue({
      state: "ready",
      email: "athlete@example.test",
      plan: "Pro",
    });
    const wizard = await openLane(bridge);

    await user.click(screen.getByRole("button", { name: "Check again" }));

    await waitFor(() => {
      expect(bridge.claudeCliRecheck).toHaveBeenCalledOnce();
      expect(identityLine()).toBe("Signed in as athlete@example.test - Claude Pro subscription");
    });
    expect(bridge.claudeCliStatus).toHaveBeenCalledOnce();
    expect(credentialBadges()).toHaveLength(10);
    expect(document.querySelector('input[data-slot="claude-cli"]')).toBeNull();
    wizard.controller.dispose();
  });

  it("keeps the last known identity when a recheck fails", async () => {
    const user = userEvent.setup();
    const bridge = claudeBridge({ state: "ready", email: "athlete@example.test", plan: "Max" });
    bridge.claudeCliRecheck.mockRejectedValue(new Error("probe unavailable"));
    const wizard = await openLane(bridge);

    await user.click(screen.getByRole("button", { name: "Check again" }));

    await waitFor(() => {
      expect(bridge.claudeCliRecheck).toHaveBeenCalledOnce();
    });
    expect(identityLine()).toBe("Signed in as athlete@example.test - Claude Max subscription");
    expect(document.body.textContent).not.toContain("probe unavailable");
    wizard.controller.dispose();
  });

  it("preselects the lane when the daemon reports it as the active provider", async () => {
    const bridge = claudeBridge({ state: "ready", email: "athlete@example.test", plan: "Max" });
    bridge.llmConfiguration.mockResolvedValue(ACTIVE_CLAUDE_CLI_CONFIGURATION);
    const wizard = await openLane(bridge);

    expect(control<HTMLSelectElement>("onboarding-llm-provider").value).toBe("claude-cli");
    expect(control<HTMLSelectElement>("onboarding-llm-model").value).toBe("sonnet");
    wizard.controller.dispose();
  });

  it("falls back to the first provider when the daemon reports no active provider", async () => {
    const wizard = await openLane(
      claudeBridge({ state: "ready", email: "athlete@example.test", plan: "Max" }),
    );

    expect(control<HTMLSelectElement>("onboarding-llm-provider").value).toBe("anthropic");
    expect(control<HTMLSelectElement>("onboarding-llm-model").value).toBe("claude-sonnet-4-6");
    wizard.controller.dispose();
  });

  it("advances a probe-ready lane without any credential entry", async () => {
    const user = userEvent.setup();
    const ready = claudeBridge({ state: "ready", email: "athlete@example.test", plan: "Max" });
    const wizard = await openLane(ready);
    await user.selectOptions(control<HTMLSelectElement>("onboarding-llm-provider"), "claude-cli");

    await user.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => {
      expect(ready.applyLlmSelection).toHaveBeenCalledOnce();
      expect(wizard.controller.state().step).toBe("training-data");
    });
    expect(ready.applyLlmSelection.mock.calls[0]?.[0]?.provider).toBe("claude-cli");
    expect(ready.writeCredential).not.toHaveBeenCalled();
    wizard.controller.dispose();
  });

  it("holds a signed-out lane on the coach step when the daemon refuses it", async () => {
    const user = userEvent.setup();
    const signedOut = claudeBridge({ state: "not-logged-in" });
    signedOut.applyLlmSelection.mockResolvedValue({
      status: "refused",
      reason: "credential-required",
    });
    const wizard = await openLane(signedOut);
    await user.selectOptions(control<HTMLSelectElement>("onboarding-llm-provider"), "claude-cli");

    await user.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => {
      expect(signedOut.applyLlmSelection).toHaveBeenCalledOnce();
    });
    expect(wizard.controller.state().step).toBe("coach-keys");
    expect(document.body.textContent).toContain("Claude Code CLI is not signed in.");
    wizard.controller.dispose();
  });

  it("never renders the lane when the daemon does not offer the provider", async () => {
    const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
    bridge.claudeCliStatus.mockResolvedValue({ state: "ready", plan: "Max" });
    const wizard = mountWizard({ bridge });

    await wizard.open();

    expect(document.querySelector(".claude-cli-state")).toBeNull();
    expect(document.body.textContent).not.toContain("Claude subscription");
    wizard.controller.dispose();
  });

  it("never leaks probe fields other than the rendered identity", async () => {
    const wizard = await openLane(
      claudeBridge({
        state: "ready",
        email: "athlete@example.test",
        plan: "Max",
        version: "2.1.0",
      }),
    );

    const rendered = document.body.textContent ?? "";
    expect(rendered).not.toContain("2.1.0");
    expect(rendered).not.toMatch(/sk-|oauth/iu);
    wizard.controller.dispose();
  });
});
