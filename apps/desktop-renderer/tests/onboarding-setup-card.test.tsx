import { randomUUID } from "node:crypto";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OnboardingLlmConfiguration } from "../src/onboarding/bridge.js";
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
  await user.selectOptions(control<HTMLSelectElement>("onboarding-prior-bsi"), "no");
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
    expect(setupRow("injury-status").parentElement).toBe(card);
    expect(setupRow("prior-bsi").parentElement).toBe(card);
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
    expect(screen.getByRole("button", { name: "Choose what powers your coach" })).toBeInTheDocument();
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
    expect(screen.getByRole("button", { name: "Change what powers your coach" })).toBeInTheDocument();
    warm.controller.dispose();
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

  it("gives every input a visible label", async () => {
    const user = userEvent.setup();
    const wizard = mountWizard({ bridge: coldBridge() });
    await wizard.open();
    await openApiKeyPanel(user);
    await openTrainingPanel(user);
    await user.selectOptions(control<HTMLSelectElement>("onboarding-prior-bsi"), "yes");
    await user.selectOptions(control<HTMLSelectElement>("onboarding-llm-model"), "__custom__");

    const controls = Array.from(
      document.querySelectorAll<HTMLElement>(
        ".onboarding input, .onboarding select, .onboarding textarea",
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

    await user.selectOptions(control<HTMLSelectElement>("onboarding-injury-status"), "none");
    expect(primaryButton()).toBeDisabled();
    await user.selectOptions(control<HTMLSelectElement>("onboarding-prior-bsi"), "no");

    await waitFor(() => {
      expect(primaryButton()).toBeEnabled();
    });
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

  it("keeps the screen monochrome", async () => {
    const wizard = mountWizard({ bridge: readyEverythingBridge() });
    await wizard.open();
    await waitFor(() => {
      expect(rowState("ai")).toBe("ready");
    });

    expect(primaryButton().className).toContain("bg-ink text-bg");
    const tick = setupRow("ai").querySelector<HTMLElement>('[data-setup-disc="ready"]');
    expect(tick?.className).toContain("text-ok");
    const pending = setupRow("prior-bsi").querySelector('[data-setup-disc="pending"]');
    expect(pending).toBeNull();
    expect(document.querySelector(".onboarding")?.outerHTML).not.toMatch(/brand/u);
    wizard.controller.dispose();
  });

  it("renders every required row in order and admits the clearance row to the same card", async () => {
    const user = userEvent.setup();
    const wizard = mountWizard({ bridge: coldBridge() });
    await wizard.open();

    expect(rowIds()).toEqual(["ai", "training", "injury-status", "prior-bsi"]);

    await user.selectOptions(control<HTMLSelectElement>("onboarding-prior-bsi"), "yes");

    expect(rowIds()).toEqual(["ai", "training", "injury-status", "prior-bsi", "clinician-cleared"]);
    expect(setupRow("clinician-cleared").parentElement).toBe(setupCard());
    expect(setupRow("prior-bsi").nextElementSibling).toBe(setupRow("clinician-cleared"));

    await user.selectOptions(control<HTMLSelectElement>("onboarding-prior-bsi"), "no");

    expect(rowIds()).toEqual(["ai", "training", "injury-status", "prior-bsi"]);
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

  it("closes the intervals.icu editor without writing when it is backed out of", async () => {
    const user = userEvent.setup();
    const bridge = coldBridge();
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await openTrainingPanel(user);
    seedSecret("intervals-icu", randomUUID());

    await user.click(
      within(panel("training") as HTMLElement).getByRole("button", { name: "Cancel Intervals.icu setup" }),
    );

    await waitFor(() => {
      expect(panel("training")).toBeNull();
    });
    expect(bridge.writeCredential).not.toHaveBeenCalled();
    expect(rowState("training")).toBe("pending");
    expect(trigger("training").textContent).toBe("Connect");
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
    expect(rowSubtitle("training")).toBe("Connected — where your rides come from");
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
    expect(control("onboarding-prior-bsi").hasAttribute("aria-describedby")).toBe(false);
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
});
