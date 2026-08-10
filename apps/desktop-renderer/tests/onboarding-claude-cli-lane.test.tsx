import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { OnboardingBridge, OnboardingLlmConfiguration } from "../src/onboarding/bridge.js";
import type { ClaudeCliState } from "../src/onboarding/constants.js";
import { claudeCliPresentation } from "../src/onboarding/credential-presentation.js";
import type { ClaudeCliStatus } from "../src/onboarding/machine.js";
import {
  chooseLane,
  claudeCliNoteText,
  control,
  mountWizard,
  openApiKeyPanel,
  openLaneMenu,
  resetOnboardingStore,
  rowState,
  rowSubtitle,
  setupRow,
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

async function openLane(bridge: TestBridge): Promise<ReturnType<typeof mountWizard>> {
  const wizard = mountWizard({ bridge });
  await wizard.open();
  await waitFor(() => {
    expect(bridge.claudeCliStatus).toHaveBeenCalled();
    expect(wizard.controller.state().claudeCliState).not.toBeNull();
  });
  return wizard;
}

function laneItem(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-lane="claude-cli"]');
}

describe("claude-cli onboarding lane", () => {
  afterEach(() => {
    resetOnboardingStore();
  });

  it("opens Setup before the account probe answers and explains it is still checking", async () => {
    const user = userEvent.setup();
    let settle: ((status: ClaudeCliStatus) => void) | undefined;
    const bridge = claudeBridge({ state: "ready" });
    bridge.claudeCliStatus.mockReturnValue(
      new Promise<ClaudeCliStatus>((resolve) => {
        settle = resolve;
      }),
    );
    const wizard = mountWizard({ bridge });

    await wizard.open();
    await openLaneMenu(user);

    expect(laneItem()).toBeNull();
    expect(claudeCliNoteText()).toBe(claudeCliPresentation(null).detail);
    expect(document.body.textContent).toContain("Checking the Claude Code CLI sign-in on this Mac");

    await act(async () => {
      settle?.({ state: "ready", email: "athlete@example.test", plan: "Max" });
    });

    await waitFor(() => {
      expect(laneItem()).not.toBeNull();
    });
    expect(claudeCliNoteText()).toBeNull();
    wizard.controller.dispose();
  });

  it("offers the lane and carries the signed-in identity into the row", async () => {
    const user = userEvent.setup();
    const wizard = await openLane(
      claudeBridge({
        state: "ready",
        email: "athlete@example.test",
        plan: "Max",
        version: "2.1.0",
      }),
    );

    await chooseLane(user, "claude-cli");

    expect(rowState("ai")).toBe("ready");
    expect(setupRow("ai").textContent).toContain("Claude Code");
    expect(rowSubtitle("ai")).toBe(
      "Powers your coach · Signed in as athlete@example.test - Claude Max subscription",
    );
    expect(document.body.textContent).not.toContain("undefined");
    wizard.controller.dispose();
  });

  it("falls back to the email alone when the probe reports no plan", async () => {
    const user = userEvent.setup();
    const wizard = await openLane(claudeBridge({ state: "ready", email: "athlete@example.test" }));

    await chooseLane(user, "claude-cli");

    expect(rowSubtitle("ai")).toBe("Powers your coach · Signed in as athlete@example.test");
    expect(document.body.textContent).not.toContain("Claude undefined subscription");
    wizard.controller.dispose();
  });

  it("keeps the plan when the email is unavailable", async () => {
    const user = userEvent.setup();
    const wizard = await openLane(claudeBridge({ state: "ready", plan: "Pro" }));

    await chooseLane(user, "claude-cli");

    expect(rowSubtitle("ai")).toBe("Powers your coach · Signed in - Claude Pro subscription");
    wizard.controller.dispose();
  });

  it("names API key billing instead of claiming a subscription", async () => {
    const user = userEvent.setup();
    const wizard = await openLane(claudeBridge({ state: "ready-api-key" }));

    await chooseLane(user, "claude-cli");

    expect(rowSubtitle("ai")).toBe(
      "Powers your coach · Using Anthropic API key billing - usage is charged to your API account.",
    );
    expect(rowSubtitle("ai")).not.toContain("subscription");
    wizard.controller.dispose();
  });

  it.each([
    { state: "not-logged-in" },
    { state: "api-key-token" },
    { state: "absent-binary" },
    { state: "disabled" },
  ] as const satisfies ReadonlyArray<{ readonly state: ClaudeCliState }>)(
    "leaves the lane out of the menu and explains $state in place",
    async ({ state }) => {
      const user = userEvent.setup();
      const wizard = await openLane(claudeBridge({ state }));

      await openLaneMenu(user);

      expect(laneItem()).toBeNull();
      expect(claudeCliNoteText()).toBe(claudeCliPresentation(state).detail);
      expect(document.querySelector('input[data-slot="claude-cli"]')).toBeNull();
      wizard.controller.dispose();
    },
  );

  it("rechecks the account from the menu note and never grows a key field", async () => {
    const user = userEvent.setup();
    const bridge = claudeBridge({ state: "not-logged-in" });
    bridge.claudeCliRecheck.mockResolvedValue({
      state: "ready",
      email: "athlete@example.test",
      plan: "Pro",
    });
    const wizard = await openLane(bridge);
    await openLaneMenu(user);

    await user.click(screen.getByRole("menuitem", { name: "Check again" }));

    await waitFor(() => {
      expect(bridge.claudeCliRecheck).toHaveBeenCalledOnce();
    });
    await waitFor(() => {
      expect(wizard.controller.state().claudeCliState).toBe("ready");
    });
    await openLaneMenu(user);
    expect(laneItem()).not.toBeNull();
    expect(claudeCliNoteText()).toBeNull();
    expect(bridge.claudeCliStatus).toHaveBeenCalledOnce();
    expect(document.querySelector('input[data-slot="claude-cli"]')).toBeNull();
    wizard.controller.dispose();
  });

  it("keeps the last known identity when a recheck fails", async () => {
    const user = userEvent.setup();
    const bridge = claudeBridge({ state: "ready", email: "athlete@example.test", plan: "Max" });
    bridge.claudeCliRecheck.mockRejectedValue(new Error("probe unavailable"));
    const wizard = await openLane(bridge);
    await chooseLane(user, "claude-cli");

    act(() => {
      wizard.controller.recheckClaudeCli();
    });

    await waitFor(() => {
      expect(bridge.claudeCliRecheck).toHaveBeenCalledOnce();
    });
    await waitFor(() => {
      expect(wizard.controller.state().busy).toBe(false);
    });
    expect(rowSubtitle("ai")).toBe(
      "Powers your coach · Signed in as athlete@example.test - Claude Max subscription",
    );
    expect(document.body.textContent).not.toContain("probe unavailable");
    wizard.controller.dispose();
  });

  it("preselects the lane when the daemon reports it as the active provider", async () => {
    const bridge = claudeBridge({ state: "ready", email: "athlete@example.test", plan: "Max" });
    bridge.llmConfiguration.mockResolvedValue(ACTIVE_CLAUDE_CLI_CONFIGURATION);
    const wizard = await openLane(bridge);

    await waitFor(() => {
      expect(rowState("ai")).toBe("ready");
    });
    expect(setupRow("ai").textContent).toContain("Claude Code");
    wizard.controller.dispose();
  });

  it("falls back to the first provider when the daemon reports no active provider", async () => {
    const user = userEvent.setup();
    const wizard = await openLane(
      claudeBridge({ state: "ready", email: "athlete@example.test", plan: "Max" }),
    );
    await openApiKeyPanel(user);

    expect(control<HTMLSelectElement>("onboarding-llm-provider").value).toBe("anthropic");
    expect(control<HTMLSelectElement>("onboarding-llm-model").value).toBe("claude-sonnet-4-6");
    wizard.controller.dispose();
  });

  it("marks a probe-ready lane ready without any credential entry", async () => {
    const user = userEvent.setup();
    const ready = claudeBridge({ state: "ready", email: "athlete@example.test", plan: "Max" });
    const wizard = await openLane(ready);

    await chooseLane(user, "claude-cli");

    await waitFor(() => {
      expect(rowState("ai")).toBe("ready");
    });
    expect(ready.writeCredential).not.toHaveBeenCalled();
    expect(document.querySelector('[data-setup-panel="api-key"]')).toBeNull();
    wizard.controller.dispose();
  });

  it("keeps a selected lane listed and pending after it degrades", async () => {
    const user = userEvent.setup();
    const bridge = claudeBridge({ state: "ready", email: "athlete@example.test", plan: "Max" });
    bridge.claudeCliRecheck.mockResolvedValue({ state: "not-logged-in" });
    const wizard = await openLane(bridge);
    await chooseLane(user, "claude-cli");

    act(() => {
      wizard.controller.recheckClaudeCli();
    });

    await waitFor(() => {
      expect(wizard.controller.state().claudeCliState).toBe("not-logged-in");
    });
    expect(rowState("ai")).toBe("pending");
    expect(rowSubtitle("ai")).toBe("Powers your coach · sign in from a terminal to finish");
    await openLaneMenu(user);
    expect(laneItem()).not.toBeNull();
    expect(claudeCliNoteText()).not.toBeNull();
    expect(screen.getByRole("menuitem", { name: "Check again" })).toBeInTheDocument();
    wizard.controller.dispose();
  });

  it("never names the lane when the daemon does not offer the provider", async () => {
    const user = userEvent.setup();
    const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
    bridge.chatGptStatus.mockResolvedValue({ state: "absent", runtimeReady: false });
    bridge.claudeCliStatus.mockResolvedValue({ state: "ready", plan: "Max" });
    const wizard = mountWizard({ bridge });

    await wizard.open();
    await openLaneMenu(user);

    expect(laneItem()).toBeNull();
    expect(claudeCliNoteText()).toBeNull();
    expect(document.body.textContent).not.toContain("Claude Code");
    wizard.controller.dispose();
  });

  it("never leaks probe fields other than the rendered identity", async () => {
    const user = userEvent.setup();
    const wizard = await openLane(
      claudeBridge({
        state: "ready",
        email: "athlete@example.test",
        plan: "Max",
        version: "2.1.0",
      }),
    );
    await chooseLane(user, "claude-cli");

    const rendered = document.body.textContent ?? "";
    expect(rendered).not.toContain("2.1.0");
    expect(rendered).not.toMatch(/sk-|oauth/iu);
    wizard.controller.dispose();
  });
});
