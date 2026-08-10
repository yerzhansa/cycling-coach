import { randomUUID } from "node:crypto";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OnboardingLlmConfiguration } from "../src/onboarding/bridge.js";
import {
  API_KEY_PANEL_HINT,
  FOOTER_NOTE,
  RETRY_INTAKE_SAVE_LABEL,
  SETUP_MENU_LABEL,
} from "../src/ui/onboarding/copy.js";
import {
  chooseLane,
  claudeCliNoteText,
  control,
  importResult,
  laneItems,
  laneMenu,
  mountWizard,
  openApiKeyPanel,
  openLaneMenu,
  openTrainingPanel,
  panel,
  passwordInput,
  primaryButton,
  resetOnboardingStore,
  rowState,
  rowSubtitle,
  seedSecret,
  setupCard,
  setupRow,
  testBridge,
  TEST_LLM_CONFIGURATION,
  type TestBridge,
} from "./onboarding-harness.js";

const CLAUDE_CONFIGURATION: OnboardingLlmConfiguration = {
  ...TEST_LLM_CONFIGURATION,
  providers: [
    ...TEST_LLM_CONFIGURATION.providers,
    {
      provider: "claude-cli",
      defaultModel: "sonnet",
      models: [{ value: "sonnet", label: "Claude Sonnet" }],
    },
  ],
  active: { provider: "claude-cli", model: "sonnet" },
};

function coldBridge(): TestBridge {
  const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
  bridge.chatGptStatus.mockResolvedValue({ state: "absent", runtimeReady: false });
  return bridge;
}

function claudeReadyBridge(): TestBridge {
  const bridge = coldBridge();
  bridge.llmConfiguration.mockResolvedValue(CLAUDE_CONFIGURATION);
  bridge.claudeCliStatus.mockResolvedValue({
    state: "ready",
    email: "athlete@example.test",
    plan: "Max",
  });
  bridge.claudeCliRecheck.mockResolvedValue({ state: "ready" });
  return bridge;
}

function readyEverythingBridge(): TestBridge {
  const bridge = claudeReadyBridge();
  bridge.credentialStatuses.mockResolvedValue([
    { slot: "intervals-icu", state: "configured", runtimeState: "active" },
  ]);
  return bridge;
}

function claudeSignedOutBridge(): TestBridge {
  const bridge = coldBridge();
  bridge.llmConfiguration.mockResolvedValue({ ...CLAUDE_CONFIGURATION, active: null });
  bridge.claudeCliStatus.mockResolvedValue({ state: "not-logged-in" });
  return bridge;
}

function rowIds(): readonly string[] {
  return Array.from(setupCard().children)
    .map((child) => (child as HTMLElement).dataset.setupRow ?? "")
    .filter((id) => id !== "");
}

function trigger(id: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-setup-trigger="${id}"]`);
  if (element === null) throw new Error(`Trigger not found: ${id}`);
  return element;
}

function buttonNames(host: HTMLElement | null): readonly string[] {
  return Array.from(host?.querySelectorAll("button") ?? [], (entry) => entry.textContent ?? "");
}

async function completeIntake(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.selectOptions(control<HTMLSelectElement>("onboarding-injury-status"), "none");
}

describe("setup card", () => {
  afterEach(() => {
    resetOnboardingStore();
  });

  it("renders one bordered card whose rows are dividers, not gaps", async () => {
    const wizard = mountWizard({ bridge: coldBridge() });
    await wizard.open();

    const card = setupCard();
    expect(card.className).toContain("[&>*+*]:border-t");
    expect(card.className).toContain("[&>*+*]:border-line");
    expect(card.className).toContain("[&>*:first-child]:rounded-t-xl");
    expect(card.className).toContain("[&>*:last-child]:rounded-b-xl");
    expect(card.className).not.toContain("overflow-hidden");
    expect(setupRow("ai").parentElement).toBe(card);
    expect(setupRow("training").parentElement).toBe(card);
    expect(setupRow("telegram").parentElement).toBe(card);
    expect(setupRow("injury-status").parentElement).toBe(card);
    wizard.controller.dispose();
  });

  it("keeps every sub-panel a sibling row inside the same card", async () => {
    const user = userEvent.setup();
    const wizard = mountWizard({ bridge: coldBridge() });
    await wizard.open();
    await openApiKeyPanel(user);
    await openTrainingPanel(user);

    const card = setupCard();
    expect(panel("api-key")?.parentElement).toBe(card);
    expect(panel("training")?.parentElement).toBe(card);
    expect(setupRow("ai").nextElementSibling).toBe(panel("api-key"));
    expect(setupRow("training").nextElementSibling).toBe(panel("training"));
    wizard.controller.dispose();
  });

  it("labels the AI trigger Choose when nothing is set and Change when a lane is ready", async () => {
    const cold = mountWizard({ bridge: coldBridge() });
    await cold.open();
    expect(
      screen.getByRole("button", { name: "Choose what powers your coach" }),
    ).toBeInTheDocument();
    expect(rowState("ai")).toBe("pending");
    expect(setupRow("ai").textContent).toContain("AI that powers your coach");
    expect(rowSubtitle("ai")).toBe("Required — Enduragent doesn't include one");
    cold.controller.dispose();
    cold.rendered.unmount();
    resetOnboardingStore();

    const warm = mountWizard({ bridge: claudeReadyBridge() });
    await warm.open();
    await waitFor(() => {
      expect(rowState("ai")).toBe("ready");
    });
    expect(
      screen.getByRole("button", { name: "Change what powers your coach" }),
    ).toBeInTheDocument();
    warm.controller.dispose();
  });

  it("shows an active off-catalogue provider as ready in Settings until replacement", async () => {
    const user = userEvent.setup();
    const bridge = readyEverythingBridge();
    bridge.llmConfiguration.mockResolvedValue({
      ...CLAUDE_CONFIGURATION,
      active: { provider: "codex-agent", model: "synthetic-codex" },
    });
    const wizard = mountWizard({ bridge, placement: "settings" });
    await wizard.open();

    expect(rowState("ai")).toBe("ready");
    expect(setupRow("ai").textContent).toContain("Codex agent (experimental)");
    expect(rowSubtitle("ai")).toBe("Connected · powers your coach");
    expect(screen.getByRole("button", { name: "Change what powers your coach" })).toBeEnabled();

    await openLaneMenu(user);
    expect(laneItems().map((item) => item.dataset.lane)).not.toContain("codex-agent");
    const apiKeyLane = document.querySelector<HTMLElement>('[data-lane="api-key"]');
    expect(apiKeyLane).not.toBeNull();
    await user.click(apiKeyLane as HTMLElement);
    await waitFor(() => {
      expect(panel("api-key")).not.toBeNull();
    });
    expect(rowState("ai")).toBe("pending");
    expect(
      Array.from(
        control<HTMLSelectElement>("onboarding-llm-provider").options,
        (option) => option.value,
      ),
    ).not.toContain("codex-agent");
    wizard.controller.dispose();
  });

  it("keeps the completion footer in Chat and omits it from Settings", async () => {
    const chat = mountWizard({ bridge: readyEverythingBridge() });
    await chat.open();

    expect(screen.getByRole("button", { name: "Start coaching" })).toBeInTheDocument();
    expect(screen.getByText("Everything stays on this Mac.")).toBeInTheDocument();

    chat.controller.dispose();
    chat.rendered.unmount();
    resetOnboardingStore();

    const settings = mountWizard({ bridge: readyEverythingBridge(), placement: "settings" });
    await settings.open();

    expect(screen.queryByRole("button", { name: "Start coaching" })).toBeNull();
    expect(screen.queryByText("Everything stays on this Mac.")).toBeNull();
    settings.controller.dispose();
  });

  it("autosaves Settings intake and offers a retry only after a save error", async () => {
    const user = userEvent.setup();
    const bridge = readyEverythingBridge();
    bridge.saveIntake
      .mockRejectedValueOnce(new Error("private storage detail"))
      .mockResolvedValueOnce();
    const wizard = mountWizard({ bridge, placement: "settings" });
    await wizard.open();

    expect(screen.queryByRole("button", { name: RETRY_INTAKE_SAVE_LABEL })).toBeNull();
    await user.selectOptions(control<HTMLSelectElement>("onboarding-injury-status"), "none");

    const retry = await screen.findByRole("button", { name: RETRY_INTAKE_SAVE_LABEL });
    expect(retry.className).toContain("underline");
    expect(retry.className).toContain("text-ink-2");
    expect(retry.className).not.toContain("text-danger");
    expect(document.querySelector("#onboarding-error")?.textContent).toBe(
      "Your answers could not be saved. Please try again.",
    );
    expect(bridge.saveIntake).toHaveBeenCalledOnce();

    await user.click(retry);
    await waitFor(() => {
      expect(bridge.saveIntake).toHaveBeenCalledTimes(2);
      expect(wizard.controller.state().fixedError).toBeNull();
    });
    expect(screen.queryByRole("button", { name: RETRY_INTAKE_SAVE_LABEL })).toBeNull();
    wizard.controller.dispose();
  });

  it("keeps completed Chat setup changes quiet and omits deletion controls", async () => {
    const wizard = mountWizard({ bridge: readyEverythingBridge() });
    await wizard.open();
    await waitFor(() => {
      expect(rowState("ai")).toBe("ready");
      expect(rowState("training")).toBe("ready");
    });

    expect(trigger("ai").className).toContain("border-transparent");
    expect(trigger("training").className).toContain("border-transparent");
    expect(screen.queryByRole("button", { name: /Delete the/u })).toBeNull();
    wizard.controller.dispose();
  });

  it("opens a menu of the offered lanes with the current one ticked", async () => {
    const user = userEvent.setup();
    const wizard = mountWizard({ bridge: claudeReadyBridge() });
    await wizard.open();
    await waitFor(() => {
      expect(rowState("ai")).toBe("ready");
    });

    await openLaneMenu(user);

    expect(laneItems().map((item) => item.dataset.lane)).toEqual([
      "claude-cli",
      "openai-codex",
      "api-key",
    ]);
    expect(laneItems().filter((item) => item.getAttribute("aria-checked") === "true").length).toBe(
      1,
    );
    expect(
      laneItems()
        .find((item) => item.dataset.lane === "claude-cli")
        ?.getAttribute("aria-checked"),
    ).toBe("true");
    wizard.controller.dispose();
  });

  it("turns a chosen not-ready lane into a pending row with its panel beneath it", async () => {
    const user = userEvent.setup();
    const wizard = mountWizard({ bridge: claudeReadyBridge() });
    await wizard.open();
    await waitFor(() => {
      expect(rowState("ai")).toBe("ready");
    });

    await chooseLane(user, "openai-codex");

    expect(rowState("ai")).toBe("pending");
    expect(rowSubtitle("ai")).toBe("Powers your coach · sign in to finish");
    expect(primaryButton()).toBeDisabled();
    expect(setupRow("ai").nextElementSibling).toBe(panel("chatgpt"));
    wizard.controller.dispose();
  });

  it("selects an already configured ChatGPT lane without asking the athlete to sign in again", async () => {
    const user = userEvent.setup();
    const bridge = claudeReadyBridge();
    bridge.chatGptStatus.mockResolvedValue({ state: "configured", runtimeReady: true });
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await waitFor(() => {
      expect(rowState("ai")).toBe("ready");
    });

    await chooseLane(user, "openai-codex");

    await waitFor(() => {
      expect(rowState("ai")).toBe("ready");
    });
    expect(panel("chatgpt")).toBeNull();
    expect(bridge.chatGptLogin).not.toHaveBeenCalled();
    wizard.controller.dispose();
  });

  it("closes ChatGPT setup after a stored profile is activated", async () => {
    const user = userEvent.setup();
    const bridge = claudeReadyBridge();
    bridge.chatGptStatus
      .mockResolvedValueOnce({ state: "configured", runtimeReady: false })
      .mockResolvedValueOnce({ state: "configured", runtimeReady: true });
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await waitFor(() => {
      expect(rowState("ai")).toBe("ready");
    });

    await chooseLane(user, "openai-codex");

    await waitFor(() => {
      expect(bridge.applyLlmSelection).toHaveBeenCalledOnce();
      expect(rowState("ai")).toBe("ready");
      expect(panel("chatgpt")).toBeNull();
    });
    expect(bridge.chatGptLogin).not.toHaveBeenCalled();
    wizard.controller.dispose();
  });

  it("reactivates the selected stored ChatGPT profile", async () => {
    const user = userEvent.setup();
    const bridge = claudeReadyBridge();
    bridge.llmConfiguration.mockResolvedValue({
      ...CLAUDE_CONFIGURATION,
      active: { provider: "openai-codex", model: "gpt-5.5" },
    });
    bridge.chatGptStatus
      .mockResolvedValueOnce({ state: "configured", runtimeReady: false })
      .mockResolvedValueOnce({ state: "configured", runtimeReady: true });
    const wizard = mountWizard({ bridge });
    await wizard.open();
    expect(rowState("ai")).toBe("pending");

    await chooseLane(user, "openai-codex");

    await waitFor(() => {
      expect(bridge.applyLlmSelection).toHaveBeenCalledOnce();
      expect(rowState("ai")).toBe("ready");
      expect(panel("chatgpt")).toBeNull();
    });
    expect(bridge.chatGptLogin).not.toHaveBeenCalled();
    wizard.controller.dispose();
  });

  it("keeps ChatGPT recovery visible when stored-profile activation fails", async () => {
    const user = userEvent.setup();
    const bridge = claudeReadyBridge();
    bridge.chatGptStatus.mockResolvedValue({ state: "configured", runtimeReady: false });
    bridge.applyLlmSelection.mockResolvedValue({
      status: "refused",
      reason: "runtime-unavailable",
    });
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await waitFor(() => {
      expect(rowState("ai")).toBe("ready");
    });

    await chooseLane(user, "openai-codex");

    await waitFor(() => {
      expect(wizard.controller.state().chatGptRuntimeState).toBe("failed");
    });
    expect(wizard.controller.state().fixedError).toBeNull();
    expect(panel("chatgpt")).not.toBeNull();
    expect(panel("chatgpt")?.textContent).toContain(
      "Signed in, but the coach could not be activated. Retry without signing in again.",
    );
    expect(screen.getByRole("button", { name: "Retry activation" })).toBeEnabled();
    wizard.controller.dispose();
  });

  it("retries a ready stored ChatGPT profile when it is chosen again", async () => {
    const user = userEvent.setup();
    const bridge = claudeReadyBridge();
    bridge.chatGptStatus.mockResolvedValue({ state: "configured", runtimeReady: true });
    bridge.applyLlmSelection
      .mockResolvedValueOnce({ status: "refused", reason: "runtime-unavailable" })
      .mockResolvedValueOnce({ status: "configured", runtimeReady: true });
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await waitFor(() => {
      expect(rowState("ai")).toBe("ready");
    });

    await chooseLane(user, "openai-codex");

    await waitFor(() => {
      expect(wizard.controller.state().chatGptRuntimeState).toBe("failed");
    });
    expect(wizard.controller.state().fixedError).toBeNull();
    expect(panel("chatgpt")).not.toBeNull();

    await chooseLane(user, "openai-codex");

    await waitFor(() => {
      expect(bridge.applyLlmSelection).toHaveBeenCalledTimes(2);
      expect(rowState("ai")).toBe("ready");
    });
    expect(wizard.controller.state().fixedError).toBeNull();
    wizard.controller.dispose();
  });

  it("offers one sign-in button and a way back from the ChatGPT panel", async () => {
    const user = userEvent.setup();
    const bridge = claudeReadyBridge();
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await waitFor(() => {
      expect(rowState("ai")).toBe("ready");
    });
    await chooseLane(user, "openai-codex");

    const chatgpt = panel("chatgpt");
    expect(chatgpt).not.toBeNull();
    expect(chatgpt?.querySelectorAll("input")).toHaveLength(0);
    expect(chatgpt?.textContent).toContain(
      "Opens OpenAI's sign-in page in your browser — you type your password there, not here.",
    );
    expect(
      Array.from(chatgpt?.querySelectorAll("button") ?? [], (entry) => entry.textContent),
    ).toEqual(["Sign in with ChatGPT", "Keep Claude Code"]);

    await user.click(screen.getByRole("button", { name: "Keep Claude Code" }));

    await waitFor(() => {
      expect(rowState("ai")).toBe("ready");
    });
    expect(panel("chatgpt")).toBeNull();
    expect(bridge.chatGptLogin).not.toHaveBeenCalled();
    wizard.controller.dispose();
  });

  it("asks for exactly a provider and a key, with model choices demoted to Advanced", async () => {
    const user = userEvent.setup();
    const wizard = mountWizard({ bridge: coldBridge() });
    await wizard.open();
    await openApiKeyPanel(user);

    expect(screen.getByLabelText("Provider")).toBe(control("onboarding-llm-provider"));
    expect(screen.getByLabelText("Anthropic API key")).toBe(passwordInput("anthropic"));
    const advanced = control("onboarding-llm-model").closest("details");
    expect(advanced).not.toBeNull();
    expect(advanced?.hasAttribute("open")).toBe(false);
    await user.selectOptions(control<HTMLSelectElement>("onboarding-llm-provider"), "openrouter");
    expect(control("onboarding-endpoint-mode").closest("details")).toBe(
      control("onboarding-llm-model").closest("details"),
    );
    await user.selectOptions(control<HTMLSelectElement>("onboarding-llm-provider"), "anthropic");

    seedSecret("anthropic", randomUUID());
    await user.click(screen.getByRole("button", { name: "Save API key" }));

    await waitFor(() => {
      expect(wizard.controller.state().busy).toBe(false);
    });
    expect(wizard.rendered).toBeDefined();
    wizard.controller.dispose();
  });

  it("edits intervals.icu in place and never opens a menu", async () => {
    const user = userEvent.setup();
    const wizard = mountWizard({ bridge: coldBridge() });
    await wizard.open();

    await openTrainingPanel(user);

    expect(laneMenu()).toBeNull();
    expect(setupRow("training").nextElementSibling).toBe(panel("training"));
    expect(screen.getByLabelText("Intervals.icu API key")).toBe(passwordInput("intervals-icu"));
    expect(panel("training")?.textContent).toContain("Developer Settings");
    expect(panel("training")?.textContent).toContain("revoke");
    wizard.controller.dispose();
  });

  it("closes intervals.icu setup after retry activates the saved key", async () => {
    const user = userEvent.setup();
    const bridge = claudeReadyBridge();
    bridge.credentialStatuses.mockResolvedValue([
      { slot: "intervals-icu", state: "configured", runtimeState: "failed" },
    ]);
    bridge.retryFailedCredentials.mockResolvedValue([
      { slot: "intervals-icu", state: "configured", runtimeState: "active" },
    ]);
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await openTrainingPanel(user);

    await user.click(screen.getByRole("button", { name: "Retry saved keys" }));

    await waitFor(() => {
      expect(rowState("training")).toBe("ready");
      expect(panel("training")).toBeNull();
    });
    expect(bridge.retryFailedCredentials).toHaveBeenCalledOnce();
    wizard.controller.dispose();
  });

  it("gives every input a visible label", async () => {
    const user = userEvent.setup();
    const wizard = mountWizard({ bridge: coldBridge() });
    await wizard.open();
    await openApiKeyPanel(user);
    await openTrainingPanel(user);
    await user.selectOptions(control<HTMLSelectElement>("onboarding-injury-status"), "returning");
    await user.selectOptions(control<HTMLSelectElement>("onboarding-llm-model"), "__custom__");

    const controls = Array.from(
      document.querySelectorAll<HTMLElement>(
        ".setup-panel input, .setup-panel select, .setup-panel textarea",
      ),
    );
    expect(controls.length).toBeGreaterThan(5);
    for (const element of controls) {
      const id = element.getAttribute("id") ?? "";
      const label = document.querySelector(`label[for="${id}"]`);
      expect(label?.textContent?.trim() ?? "").not.toBe("");
    }
    expect(control("onboarding-clinician-cleared")).toBeInTheDocument();
    wizard.controller.dispose();
  });

  it("keeps the info affordance inline in a row title and its popup outside the card", async () => {
    const user = userEvent.setup();
    const wizard = mountWizard({ bridge: coldBridge() });
    await wizard.open();
    const title = setupRow("ai").querySelector("[data-setup-row-title]");
    const trigger = title?.querySelector<HTMLElement>("[data-info-tip]");
    expect(trigger).not.toBeNull();

    await user.hover(trigger as HTMLElement);

    await waitFor(() => {
      expect(document.querySelector("[data-info-tip-popup]")).not.toBeNull();
    });
    const popup = document.querySelector("[data-info-tip-popup]") as HTMLElement;
    expect(setupCard().contains(popup)).toBe(false);
    wizard.controller.dispose();
  });

  it("keeps Start coaching disabled until every requirement is met", async () => {
    const user = userEvent.setup();
    const bridge = readyEverythingBridge();
    const onComplete = vi.fn();
    const wizard = mountWizard({ bridge, onComplete });
    await wizard.open();
    await waitFor(() => {
      expect(rowState("ai")).toBe("ready");
    });
    expect(rowState("training")).toBe("ready");
    expect(primaryButton()).toBeDisabled();
    expect(document.querySelector("[data-setup-readiness]")).toHaveTextContent(
      "2 of 3 required ready",
    );

    await user.selectOptions(control<HTMLSelectElement>("onboarding-injury-status"), "none");

    await waitFor(() => {
      expect(rowState("injury-status")).toBe("ready");
      expect(primaryButton()).toBeEnabled();
      expect(document.querySelector("[data-setup-readiness]")).toHaveTextContent(
        "3 of 3 required ready",
      );
    });
    expect(bridge.saveIntake).not.toHaveBeenCalled();
    await user.click(primaryButton());

    await waitFor(() => {
      expect(onComplete).toHaveBeenCalledOnce();
    });
    expect(bridge.saveIntake).toHaveBeenCalledOnce();
    wizard.controller.dispose();
  });

  it("stays disabled when only the intake is complete", async () => {
    const user = userEvent.setup();
    const wizard = mountWizard({ bridge: coldBridge() });
    await wizard.open();

    await completeIntake(user);

    expect(rowState("ai")).toBe("pending");
    expect(rowState("training")).toBe("pending");
    expect(primaryButton()).toBeDisabled();
    wizard.controller.dispose();
  });

  it("uses status color for completion and a quiet brand tint for the optional badge", async () => {
    const wizard = mountWizard({ bridge: readyEverythingBridge() });
    await wizard.open();
    await waitFor(() => {
      expect(rowState("ai")).toBe("ready");
    });

    expect(primaryButton().className).toContain("bg-ink text-bg");
    const tick = setupRow("ai").querySelector<HTMLElement>('[data-setup-disc="ready"]');
    expect(tick?.className).toContain("text-ok");
    const pending = setupRow("injury-status").querySelector('[data-setup-disc="pending"]');
    expect(pending).not.toBeNull();
    expect(setupRow("telegram").querySelector("[data-telegram-optional]")?.className).toContain(
      "text-brand",
    );
    wizard.controller.dispose();
  });

  it("renders every required row in order and admits the clearance row to the same card", async () => {
    const user = userEvent.setup();
    const wizard = mountWizard({ bridge: coldBridge() });
    await wizard.open();

    expect(rowIds()).toEqual(["ai", "training", "telegram", "injury-status"]);

    await user.selectOptions(control<HTMLSelectElement>("onboarding-injury-status"), "returning");

    expect(rowIds()).toEqual(["ai", "training", "telegram", "injury-status", "clinician-cleared"]);
    expect(setupRow("clinician-cleared").parentElement).toBe(setupCard());
    expect(setupRow("injury-status").nextElementSibling).toBe(setupRow("clinician-cleared"));

    await user.selectOptions(control<HTMLSelectElement>("onboarding-injury-status"), "none");

    expect(rowIds()).toEqual(["ai", "training", "telegram", "injury-status"]);
    wizard.controller.dispose();
  });

  it("describes the intake questions without promising unsupported coaching behavior", async () => {
    const user = userEvent.setup();
    const wizard = mountWizard({ bridge: coldBridge() });
    await wizard.open();

    expect(rowSubtitle("injury-status")).toBe("Records your current injury or return context.");
    await user.selectOptions(control<HTMLSelectElement>("onboarding-injury-status"), "managing");
    expect(rowSubtitle("clinician-cleared")).toBe("An answer is required before continuing.");
    wizard.controller.dispose();
  });

  it("marks a detected keyless lane ready and offers to change it without asking for a key", async () => {
    const wizard = mountWizard({ bridge: claudeReadyBridge() });
    await wizard.open();
    await waitFor(() => {
      expect(rowState("ai")).toBe("ready");
    });

    const row = setupRow("ai");
    expect(row.querySelector('[data-setup-disc="ready"]')).not.toBeNull();
    expect(row.querySelector('[data-setup-disc="pending"]')).toBeNull();
    expect(row.contains(trigger("ai"))).toBe(true);
    expect(trigger("ai").textContent).toBe("Change");
    expect(trigger("ai")).toBeEnabled();
    expect(document.querySelector("input[data-slot]")).toBeNull();
    expect(panel("api-key")).toBeNull();
    expect(panel("chatgpt")).toBeNull();
    wizard.controller.dispose();
  });

  it("reads as required with the primary button off when nothing powers the coach", async () => {
    const wizard = mountWizard({ bridge: claudeSignedOutBridge() });
    await wizard.open();
    await waitFor(() => {
      expect(wizard.controller.state().claudeCliState).toBe("not-logged-in");
    });

    expect(rowState("ai")).toBe("pending");
    expect(setupRow("ai").querySelector('[data-setup-disc="pending"]')).not.toBeNull();
    expect(setupRow("ai").textContent).toContain("AI that powers your coach");
    expect(rowSubtitle("ai")).toBe("Required — Enduragent doesn't include one");
    expect(trigger("ai").textContent).toBe("Choose");
    expect(primaryButton()).toBeDisabled();
    wizard.controller.dispose();
  });

  it("drops an unavailable lane from the menu instead of listing it disabled", async () => {
    const user = userEvent.setup();
    const wizard = mountWizard({ bridge: claudeSignedOutBridge() });
    await wizard.open();
    await waitFor(() => {
      expect(wizard.controller.state().claudeCliState).toBe("not-logged-in");
    });

    await openLaneMenu(user);

    expect(laneItems().map((item) => item.dataset.lane)).toEqual(["openai-codex", "api-key"]);
    for (const item of laneItems()) {
      expect(item.getAttribute("aria-disabled")).not.toBe("true");
      expect(item.hasAttribute("disabled")).toBe(false);
      expect(item.hasAttribute("data-disabled")).toBe(false);
    }
    expect(
      within(laneMenu() as HTMLElement).queryByRole("menuitemradio", { name: /Claude Code/u }),
    ).toBeNull();
    expect(claudeCliNoteText()).toContain("Claude Code CLI is not signed in.");
    wizard.controller.dispose();
  });

  it("restores the previous lane when the API-key panel is backed out of", async () => {
    const user = userEvent.setup();
    const bridge = claudeReadyBridge();
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await waitFor(() => {
      expect(rowState("ai")).toBe("ready");
    });

    await chooseLane(user, "api-key");

    await waitFor(() => {
      expect(panel("api-key")).not.toBeNull();
    });
    expect(rowState("ai")).toBe("pending");
    expect(buttonNames(panel("api-key"))).toEqual(["Save", "Cancel"]);

    await user.click(
      within(panel("api-key") as HTMLElement).getByRole("button", { name: "Cancel API key setup" }),
    );

    await waitFor(() => {
      expect(rowState("ai")).toBe("ready");
    });
    expect(panel("api-key")).toBeNull();
    expect(rowSubtitle("ai")).toBe(
      "Powers your coach · Signed in as athlete@example.test - Claude Max subscription",
    );
    expect(trigger("ai").textContent).toBe("Change");
    expect(bridge.writeCredential).not.toHaveBeenCalled();
    wizard.controller.dispose();
  });

  it("restores the complete provider draft when API-key editing is cancelled", async () => {
    const user = userEvent.setup();
    const bridge = coldBridge();
    bridge.llmConfiguration.mockResolvedValue({
      ...TEST_LLM_CONFIGURATION,
      active: { provider: "openrouter", model: "saved/custom-model" },
    });
    bridge.credentialStatuses.mockResolvedValue([
      { slot: "openrouter", state: "configured", runtimeState: "active" },
    ]);
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await waitFor(() => {
      expect(rowState("ai")).toBe("ready");
    });
    await openApiKeyPanel(user);

    expect(control<HTMLSelectElement>("onboarding-llm-provider").value).toBe("openrouter");
    expect(control<HTMLSelectElement>("onboarding-llm-model").value).toBe("__custom__");
    expect(control<HTMLInputElement>("onboarding-custom-model").value).toBe("saved/custom-model");
    expect(control<HTMLSelectElement>("onboarding-endpoint-mode").value).toBe("automatic");

    await user.selectOptions(
      control<HTMLSelectElement>("onboarding-llm-model"),
      "deepseek/deepseek-v4-flash",
    );
    await user.selectOptions(control<HTMLSelectElement>("onboarding-endpoint-mode"), "custom");
    await user.type(
      control<HTMLInputElement>("onboarding-custom-endpoint"),
      "https://changed.example.test/v1",
    );
    await user.selectOptions(control<HTMLSelectElement>("onboarding-llm-provider"), "anthropic");

    await user.click(
      within(panel("api-key") as HTMLElement).getByRole("button", { name: "Cancel API key setup" }),
    );
    await waitFor(() => {
      expect(panel("api-key")).toBeNull();
    });
    await openApiKeyPanel(user);

    expect(control<HTMLSelectElement>("onboarding-llm-provider").value).toBe("openrouter");
    expect(control<HTMLSelectElement>("onboarding-llm-model").value).toBe("__custom__");
    expect(control<HTMLInputElement>("onboarding-custom-model").value).toBe("saved/custom-model");
    expect(control<HTMLSelectElement>("onboarding-endpoint-mode").value).toBe("automatic");
    expect(document.querySelector("#onboarding-custom-endpoint")).toBeNull();
    wizard.controller.dispose();
  });

  it("uses a successful API-key save as the next cancellation baseline", async () => {
    const user = userEvent.setup();
    const bridge = readyEverythingBridge();
    bridge.credentialStatuses.mockResolvedValue([
      { slot: "anthropic", state: "configured", runtimeState: "active" },
      { slot: "intervals-icu", state: "configured", runtimeState: "active" },
    ]);
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await waitFor(() => {
      expect(rowState("ai")).toBe("ready");
    });
    await openApiKeyPanel(user);
    seedSecret("anthropic", randomUUID());
    await user.click(
      within(panel("api-key") as HTMLElement).getByRole("button", { name: "Save API key" }),
    );
    await waitFor(() => {
      expect(panel("api-key")).toBeNull();
    });

    await openApiKeyPanel(user);
    await user.click(
      within(panel("api-key") as HTMLElement).getByRole("button", { name: "Cancel API key setup" }),
    );
    await waitFor(() => {
      expect(panel("api-key")).toBeNull();
    });
    await openApiKeyPanel(user);

    expect(control<HTMLSelectElement>("onboarding-llm-provider").value).toBe("anthropic");
    wizard.controller.dispose();
  });

  it("uses a successful ChatGPT login as the next cancellation baseline", async () => {
    const user = userEvent.setup();
    const bridge = claudeReadyBridge();
    bridge.chatGptStatus
      .mockResolvedValueOnce({ state: "absent", runtimeReady: false })
      .mockResolvedValue({ state: "configured", runtimeReady: true });
    bridge.chatGptLogin.mockImplementation(async ({ operationId }) => ({
      status: "stored",
      operationId,
    }));
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await waitFor(() => {
      expect(rowState("ai")).toBe("ready");
    });
    await chooseLane(user, "openai-codex");
    await user.click(screen.getByRole("button", { name: "Sign in with ChatGPT" }));
    await waitFor(() => {
      expect(panel("chatgpt")).toBeNull();
    });

    await openApiKeyPanel(user);
    await user.click(
      within(panel("api-key") as HTMLElement).getByRole("button", { name: "Cancel API key setup" }),
    );
    await waitFor(() => {
      expect(panel("api-key")).toBeNull();
    });

    expect(rowState("ai")).toBe("ready");
    expect(rowSubtitle("ai")).toBe("Connected · powers your coach");
    wizard.controller.dispose();
  });

  it("closes the intervals.icu editor without writing when it is backed out of", async () => {
    const user = userEvent.setup();
    const bridge = coldBridge();
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await openTrainingPanel(user);
    seedSecret("intervals-icu", randomUUID());

    await user.click(
      within(panel("training") as HTMLElement).getByRole("button", {
        name: "Cancel Intervals.icu setup",
      }),
    );

    await waitFor(() => {
      expect(panel("training")).toBeNull();
    });
    expect(bridge.writeCredential).not.toHaveBeenCalled();
    expect(rowState("training")).toBe("pending");
    expect(trigger("training").textContent).toBe("Connect");
    wizard.controller.dispose();
  });

  it("closes the intervals.icu panel once the saved key comes back connected", async () => {
    const user = userEvent.setup();
    const bridge = coldBridge();
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await openTrainingPanel(user);
    seedSecret("intervals-icu", randomUUID());
    bridge.credentialStatuses.mockResolvedValue([
      { slot: "intervals-icu", state: "configured", runtimeState: "active" },
    ]);

    await user.click(
      within(panel("training") as HTMLElement).getByRole("button", {
        name: "Save Intervals.icu API key",
      }),
    );

    await waitFor(() => {
      expect(rowState("training")).toBe("ready");
    });
    await waitFor(() => {
      expect(panel("training")).toBeNull();
    });
    expect(trigger("training").textContent).toBe("Change");
    wizard.controller.dispose();
  });

  it("keeps an open intervals.icu draft when the AI row finishes saving", async () => {
    const user = userEvent.setup();
    const bridge = readyEverythingBridge();
    bridge.credentialStatuses.mockResolvedValue([
      { slot: "anthropic", state: "configured", runtimeState: "active" },
      { slot: "intervals-icu", state: "configured", runtimeState: "active" },
    ]);
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await waitFor(() => {
      expect(rowState("ai")).toBe("ready");
    });
    await openApiKeyPanel(user);
    await openTrainingPanel(user);
    seedSecret("anthropic", randomUUID());
    const trainingSecret = randomUUID();
    seedSecret("intervals-icu", trainingSecret);

    await user.click(
      within(panel("api-key") as HTMLElement).getByRole("button", { name: "Save API key" }),
    );

    await waitFor(() => {
      expect(panel("api-key")).toBeNull();
    });
    expect(panel("training")).not.toBeNull();
    expect(passwordInput("intervals-icu").value).toBe(trainingSecret);
    wizard.controller.dispose();
  });

  it("keeps an open AI draft when the intervals.icu row finishes saving", async () => {
    const user = userEvent.setup();
    const bridge = coldBridge();
    bridge.llmConfiguration.mockResolvedValue({
      ...TEST_LLM_CONFIGURATION,
      active: { provider: "anthropic", model: "claude-sonnet-4-6" },
    });
    bridge.credentialStatuses.mockResolvedValue([
      { slot: "anthropic", state: "configured", runtimeState: "active" },
      { slot: "intervals-icu", state: "configured", runtimeState: "active" },
    ]);
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await waitFor(() => {
      expect(rowState("ai")).toBe("ready");
    });
    await openApiKeyPanel(user);
    await openTrainingPanel(user);
    const aiSecret = randomUUID();
    seedSecret("anthropic", aiSecret);
    seedSecret("intervals-icu", randomUUID());

    await user.click(
      within(panel("training") as HTMLElement).getByRole("button", {
        name: "Save Intervals.icu API key",
      }),
    );

    await waitFor(() => {
      expect(panel("training")).toBeNull();
    });
    expect(panel("api-key")).not.toBeNull();
    expect(passwordInput("anthropic").value).toBe(aiSecret);
    wizard.controller.dispose();
  });

  it("names what is still outstanding beside a blocked Start coaching", async () => {
    const user = userEvent.setup();
    const wizard = mountWizard({ bridge: readyEverythingBridge() });
    await wizard.open();
    await waitFor(() => {
      expect(rowState("training")).toBe("ready");
    });

    const outstanding = (): HTMLElement | null =>
      document.querySelector<HTMLElement>("[data-setup-outstanding]");

    expect(primaryButton()).toBeDisabled();
    expect(outstanding()?.getAttribute("data-setup-outstanding")).toBe("intake");
    expect(outstanding()?.textContent).toBe("Answer the injury question to finish.");

    await user.selectOptions(control<HTMLSelectElement>("onboarding-injury-status"), "returning");

    expect(primaryButton()).toBeDisabled();
    expect(outstanding()?.getAttribute("data-setup-outstanding")).toBe("clearance");
    expect(outstanding()?.textContent).toBe("Confirm clinician clearance above to finish.");

    await user.selectOptions(control<HTMLSelectElement>("onboarding-clinician-cleared"), "yes");

    await waitFor(() => {
      expect(primaryButton()).toBeEnabled();
    });
    expect(outstanding()).toBeNull();
    wizard.controller.dispose();
  });

  it("names the intervals.icu row by where the rides come from", async () => {
    const missing = mountWizard({ bridge: coldBridge() });
    await missing.open();
    expect(rowSubtitle("training")).toBe("Required — where your rides come from");
    expect(trigger("training").textContent).toBe("Connect");
    expect(rowState("training")).toBe("pending");
    missing.controller.dispose();
    missing.rendered.unmount();
    resetOnboardingStore();

    const connected = mountWizard({ bridge: readyEverythingBridge() });
    await connected.open();
    await waitFor(() => {
      expect(rowState("training")).toBe("ready");
    });
    expect(rowSubtitle("training")).toBe("Connected · where your rides come from");
    expect(trigger("training").textContent).toBe("Change");
    connected.controller.dispose();
  });

  it("names the intervals.icu row after an import replaces the key", async () => {
    const bridge = coldBridge();
    bridge.importFiles.mockResolvedValue(importResult({ total: 1, imported: 1, quarantined: 0 }));
    const wizard = mountWizard({ bridge });
    await wizard.open();
    expect(rowState("training")).toBe("pending");

    act(() => {
      wizard.controller.importDroppedFiles(["/synthetic/ride.fit"]);
    });

    await waitFor(() => {
      expect(rowState("training")).toBe("ready");
    });
    expect(rowSubtitle("training")).toBe("Ride files imported to this Mac");
    expect(trigger("training").textContent).toBe("Connect");
    wizard.controller.dispose();
  });

  it("labels the demoted custom model and endpoint fields", async () => {
    const user = userEvent.setup();
    const wizard = mountWizard({ bridge: coldBridge() });
    await wizard.open();
    await openApiKeyPanel(user);
    await user.selectOptions(control<HTMLSelectElement>("onboarding-llm-provider"), "openrouter");
    await user.selectOptions(control<HTMLSelectElement>("onboarding-llm-model"), "__custom__");
    await user.selectOptions(control<HTMLSelectElement>("onboarding-endpoint-mode"), "custom");

    expect(screen.getByLabelText("Custom model name")).toBe(control("onboarding-custom-model"));
    expect(screen.getByLabelText("Endpoint")).toBe(control("onboarding-endpoint-mode"));
    expect(screen.getByLabelText("Custom endpoint")).toBe(control("onboarding-custom-endpoint"));
    expect(screen.getByLabelText("OpenRouter API key")).toBe(passwordInput("openrouter"));
    wizard.controller.dispose();
  });

  it("names claude-cli in the menu only when it is signed in", async () => {
    const user = userEvent.setup();
    const bridge = claudeReadyBridge();
    bridge.llmConfiguration.mockResolvedValue({ ...CLAUDE_CONFIGURATION, active: null });
    bridge.claudeCliStatus.mockResolvedValue({ state: "not-logged-in" });
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await waitFor(() => {
      expect(bridge.claudeCliStatus).toHaveBeenCalled();
    });

    await openLaneMenu(user);

    expect(document.querySelector('[data-lane="claude-cli"]')).toBeNull();
    expect(claudeCliNoteText()).toContain("Claude Code CLI is not signed in.");
    wizard.controller.dispose();
  });
});

function errorAnnouncer(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".onboarding-error-announcer");
}

function rowAnnouncer(id: string): HTMLElement | null {
  return setupRow(id).querySelector<HTMLElement>(`[data-setup-announce="${id}"]`);
}

describe("setup card accessibility", () => {
  afterEach(() => {
    resetOnboardingStore();
  });

  it("announces errors through a region that is mounted before the error exists", async () => {
    const user = userEvent.setup();
    const bridge = coldBridge();
    bridge.writeCredential.mockResolvedValue({
      slot: "intervals-icu",
      status: "refused",
      reason: "invalid-input",
    });
    const wizard = mountWizard({ bridge });
    await wizard.open();

    const announcer = errorAnnouncer();
    expect(announcer).not.toBeNull();
    expect(announcer?.getAttribute("aria-live")).toBe("polite");
    expect(announcer?.textContent).toBe("");

    await openTrainingPanel(user);
    seedSecret("intervals-icu", randomUUID());
    await user.click(
      within(panel("training") as HTMLElement).getByRole("button", {
        name: "Save Intervals.icu API key",
      }),
    );

    await waitFor(() => {
      expect(wizard.controller.state().fixedError).toBe("invalid-input");
    });
    expect(errorAnnouncer()).toBe(announcer);
    expect(announcer?.textContent).toBe("That key was not accepted. Check it and enter it again.");
    expect(document.querySelector("#onboarding-error")?.hasAttribute("aria-live")).toBe(false);
    wizard.controller.dispose();
  });

  it("describes only the controls in the section that owns the error", async () => {
    const user = userEvent.setup();
    const bridge = coldBridge();
    bridge.writeCredential.mockResolvedValue({
      slot: "anthropic",
      status: "refused",
      reason: "invalid-input",
    });
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await openApiKeyPanel(user);

    expect(passwordInput("anthropic").hasAttribute("aria-describedby")).toBe(false);
    expect(control("onboarding-injury-status").hasAttribute("aria-describedby")).toBe(false);

    seedSecret("anthropic", randomUUID());
    await user.click(
      within(panel("api-key") as HTMLElement).getByRole("button", { name: "Save API key" }),
    );

    await waitFor(() => {
      expect(wizard.controller.state().fixedError).toBe("invalid-input");
    });
    expect(passwordInput("anthropic").getAttribute("aria-describedby")).toBe("onboarding-error");
    expect(control("onboarding-injury-status").hasAttribute("aria-describedby")).toBe(false);
    wizard.controller.dispose();
  });

  it("returns focus to the row trigger when a sub-panel is backed out of", async () => {
    const user = userEvent.setup();
    const wizard = mountWizard({ bridge: coldBridge() });
    await wizard.open();

    await openTrainingPanel(user);
    await user.click(
      within(panel("training") as HTMLElement).getByRole("button", {
        name: "Cancel Intervals.icu setup",
      }),
    );
    await waitFor(() => {
      expect(panel("training")).toBeNull();
    });
    expect(document.activeElement).toBe(trigger("training"));

    await openApiKeyPanel(user);
    await user.click(
      within(panel("api-key") as HTMLElement).getByRole("button", { name: "Cancel API key setup" }),
    );
    await waitFor(() => {
      expect(panel("api-key")).toBeNull();
    });
    expect(document.activeElement).toBe(trigger("ai"));
    wizard.controller.dispose();
  });

  it("exposes the intervals.icu disclosure state on its trigger", async () => {
    const user = userEvent.setup();
    const wizard = mountWizard({ bridge: coldBridge() });
    await wizard.open();

    expect(trigger("training").getAttribute("aria-expanded")).toBe("false");
    expect(trigger("training").hasAttribute("aria-controls")).toBe(false);

    await openTrainingPanel(user);

    const host = panel("training") as HTMLElement;
    expect(trigger("training").getAttribute("aria-expanded")).toBe("true");
    expect(host.id).not.toBe("");
    expect(trigger("training").getAttribute("aria-controls")).toBe(host.id);
    wizard.controller.dispose();
  });

  it("announces the sub-panel a lane choice reveals", async () => {
    const user = userEvent.setup();
    const wizard = mountWizard({ bridge: coldBridge() });
    await wizard.open();

    const announcer = rowAnnouncer("ai");
    expect(announcer).not.toBeNull();
    expect(announcer?.getAttribute("aria-live")).toBe("polite");
    expect(announcer?.textContent).toBe("");

    await openApiKeyPanel(user);

    expect(rowAnnouncer("ai")).toBe(announcer);
    expect(announcer?.textContent).toBe("API key setup opened below this row.");

    await chooseLane(user, "openai-codex");

    await waitFor(() => {
      expect(panel("chatgpt")).not.toBeNull();
    });
    expect(rowAnnouncer("ai")).toBe(announcer);
    expect(announcer?.textContent).toBe("ChatGPT sign-in opened below this row.");
    wizard.controller.dispose();
  });

  it("gives co-visible controls distinct accessible names", async () => {
    const user = userEvent.setup();
    const wizard = mountWizard({ bridge: readyEverythingBridge() });
    await wizard.open();
    await waitFor(() => {
      expect(rowState("ai")).toBe("ready");
    });
    await openApiKeyPanel(user);
    await openTrainingPanel(user);

    expect(screen.queryAllByRole("button", { name: "Change" })).toHaveLength(0);
    expect(screen.queryAllByRole("button", { name: "Save" })).toHaveLength(0);
    expect(screen.queryAllByRole("button", { name: "Cancel" })).toHaveLength(0);
    for (const name of [
      "Change what powers your coach",
      "Change Intervals.icu",
      "Save API key",
      "Save Intervals.icu API key",
      "Cancel API key setup",
      "Cancel Intervals.icu setup",
    ]) {
      expect(screen.getAllByRole("button", { name })).toHaveLength(1);
    }
    wizard.controller.dispose();
  });

  it("uses stronger tokens for compact Setup copy and essential control edges", async () => {
    const user = userEvent.setup();
    const wizard = mountWizard({ bridge: coldBridge() });
    await wizard.open();

    const compactCopy = [
      setupRow("ai").querySelector("[data-setup-row-title]")?.nextElementSibling,
      screen.getByText(FOOTER_NOTE),
      document.querySelector("[data-setup-outstanding]"),
      document.querySelector("[data-info-tip]"),
    ];
    for (const element of compactCopy) {
      expect(element?.className).toContain("text-ink-2");
      expect(element?.className).not.toContain("text-ink-3");
    }
    for (const element of [
      trigger("ai"),
      trigger("training"),
      control("onboarding-injury-status"),
    ]) {
      expect(element.className).toContain("border-ink-2");
      expect(element.className).not.toContain("border-line-2");
    }

    await openLaneMenu(user);
    expect(within(laneMenu() as HTMLElement).getByText(SETUP_MENU_LABEL).className).toContain(
      "text-ink-2",
    );
    for (const hint of document.querySelectorAll<HTMLElement>("[data-lane] i")) {
      expect(hint.className).toContain("text-ink-2");
    }
    await user.click(document.querySelector<HTMLElement>('[data-lane="api-key"]') as HTMLElement);
    await waitFor(() => {
      expect(panel("api-key")).not.toBeNull();
    });
    expect(screen.getByText(API_KEY_PANEL_HINT).className).toContain("text-ink-2");
    expect(control("onboarding-llm-provider").className).toContain("border-ink-2");
    wizard.controller.dispose();
  });
});
