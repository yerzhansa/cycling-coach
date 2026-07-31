import { randomUUID } from "node:crypto";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OnboardingBridge } from "../src/onboarding/bridge.js";
import {
  control,
  credentialBadges,
  mountWizard,
  resetOnboardingStore,
  seedSecret,
  testBridge,
  type TestBridge,
} from "./onboarding-harness.js";

function activeBadges(): readonly HTMLElement[] {
  return credentialBadges().filter((badge) => badge.dataset.state === "configured");
}

function expectOneActiveProvider(): void {
  expect(credentialBadges()).toHaveLength(10);
  expect(activeBadges()).toHaveLength(1);
}

function twoProviderBridge(overrides: Partial<OnboardingBridge>): TestBridge {
  const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
  bridge.chatGptStatus.mockResolvedValue({ state: "absent", runtimeReady: false });
  bridge.llmConfiguration.mockResolvedValue({
    schemaVersion: 1,
    providers: [
      {
        provider: "anthropic",
        defaultModel: "claude-sonnet-4-6",
        models: [{ value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" }],
      },
      {
        provider: "openai-codex",
        defaultModel: "gpt-5.5",
        models: [{ value: "gpt-5.5", label: "GPT-5.5" }],
      },
    ],
    active: null,
  });
  return Object.assign(bridge, overrides);
}

describe("onboarding provider status", () => {
  afterEach(() => {
    resetOnboardingStore();
  });

  it("shows only ChatGPT as active after sign-in supersedes an API-key provider", async () => {
    const user = userEvent.setup();
    let selectedProvider: "anthropic" | "chatgpt" = "anthropic";
    const credentialStatuses = vi.fn(async () => [
      {
        slot: "anthropic" as const,
        state: "configured" as const,
        runtimeState:
          selectedProvider === "anthropic" ? ("active" as const) : ("stored-inactive" as const),
      },
    ]);
    const chatGptStatus = vi.fn(async () => ({
      state: selectedProvider === "chatgpt" ? ("configured" as const) : ("absent" as const),
      runtimeReady: selectedProvider === "chatgpt",
    }));
    const chatGptLogin = vi.fn(async () => {
      selectedProvider = "chatgpt";
      return { status: "configured" as const, runtimeReady: true as const };
    });
    const bridge = twoProviderBridge({ credentialStatuses, chatGptStatus, chatGptLogin });
    const wizard = mountWizard({ bridge });
    await wizard.open();

    await user.click(screen.getByRole("button", { name: "Sign in with ChatGPT" }));

    await waitFor(() => {
      expect(credentialStatuses).toHaveBeenCalledTimes(2);
      expectOneActiveProvider();
    });
    expect(activeBadges()[0]?.textContent).toBe("Configured");
    expect(screen.getByText("Saved · Not in use").dataset.state).toBe("stored-inactive");
    expect(document.body.textContent).not.toContain("Retry saved keys");
    expect(chatGptStatus).toHaveBeenCalledTimes(2);
    wizard.controller.dispose();
  });

  it("shows only the API-key provider as active after a key save", async () => {
    const user = userEvent.setup();
    let selectedProvider: "anthropic" | "chatgpt" = "chatgpt";
    const credentialStatuses = vi.fn(async () =>
      selectedProvider === "anthropic"
        ? [
            {
              slot: "anthropic" as const,
              state: "configured" as const,
              runtimeState: "active" as const,
            },
          ]
        : [],
    );
    const chatGptStatus = vi.fn(async () => ({
      state: "configured" as const,
      runtimeReady: selectedProvider === "chatgpt",
    }));
    const writeCredential = vi.fn(async () => {
      selectedProvider = "anthropic";
      return {
        slot: "anthropic" as const,
        status: "configured" as const,
        runtimeReady: true as const,
      };
    });
    const bridge = twoProviderBridge({ credentialStatuses, chatGptStatus, writeCredential });
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await user.selectOptions(control<HTMLSelectElement>("onboarding-llm-provider"), "anthropic");
    seedSecret("anthropic", randomUUID());

    await user.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => {
      expect(credentialStatuses).toHaveBeenCalledTimes(2);
    });
    await user.click(screen.getByRole("button", { name: "Back" }));
    expectOneActiveProvider();
    expect(activeBadges()[0]?.textContent).toBe("Configured");
    expect(screen.getByText("Saved · Not in use").dataset.state).toBe("stored-inactive");
    wizard.controller.dispose();
  });

  it("shows only the selected API-key provider as active after Continue succeeds", async () => {
    const user = userEvent.setup();
    let selectedProvider: "anthropic" | "chatgpt" = "chatgpt";
    const credentialStatuses = vi.fn(async () => [
      {
        slot: "anthropic" as const,
        state: "configured" as const,
        runtimeState: selectedProvider === "anthropic" ? ("active" as const) : ("failed" as const),
      },
    ]);
    const chatGptStatus = vi.fn(async () => ({
      state: "configured" as const,
      runtimeReady: selectedProvider === "chatgpt",
    }));
    const applyLlmSelection = vi.fn(async () => {
      selectedProvider = "anthropic";
      return { status: "configured" as const, runtimeReady: true as const };
    });
    const bridge = twoProviderBridge({ credentialStatuses, chatGptStatus, applyLlmSelection });
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await user.selectOptions(control<HTMLSelectElement>("onboarding-llm-provider"), "anthropic");

    await user.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => {
      expect(applyLlmSelection).toHaveBeenCalledOnce();
      expect(chatGptStatus).toHaveBeenCalledTimes(2);
    });
    await user.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => {
      expectOneActiveProvider();
    });
    expect(activeBadges()[0]?.textContent).toBe("Configured");
    expect(document.body.textContent).toContain(
      "Your ChatGPT sign-in is saved. Sign in again to activate it.",
    );
    expect(document.body.textContent).not.toContain("ChatGPT is ready.");
    wizard.controller.dispose();
  });

  it("fails ChatGPT activity closed when its post-selection status is unavailable", async () => {
    const user = userEvent.setup();
    let selectedProvider: "anthropic" | "chatgpt" = "chatgpt";
    const chatGptStatus = vi
      .fn<OnboardingBridge["chatGptStatus"]>()
      .mockResolvedValueOnce({ state: "configured", runtimeReady: true })
      .mockRejectedValueOnce(new Error("private status failure"));
    const credentialStatuses = vi.fn(async () => [
      {
        slot: "anthropic" as const,
        state: "configured" as const,
        runtimeState: selectedProvider === "anthropic" ? ("active" as const) : ("failed" as const),
      },
    ]);
    const applyLlmSelection = vi.fn(async () => {
      selectedProvider = "anthropic";
      return { status: "configured" as const, runtimeReady: true as const };
    });
    const bridge = twoProviderBridge({ credentialStatuses, chatGptStatus, applyLlmSelection });
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await user.selectOptions(control<HTMLSelectElement>("onboarding-llm-provider"), "anthropic");

    await user.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => {
      expect(applyLlmSelection).toHaveBeenCalledOnce();
      expect(chatGptStatus).toHaveBeenCalledTimes(2);
    });
    await user.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => {
      expectOneActiveProvider();
    });
    expect(activeBadges()[0]?.textContent).toBe("Configured");
    expect(document.body.textContent).toContain(
      "Your ChatGPT sign-in is saved. Sign in again to activate it.",
    );
    expect(document.body.textContent).not.toContain("private status failure");
    wizard.controller.dispose();
  });

  it("does not report a completed sign-in as refused when status refresh fails", async () => {
    const user = userEvent.setup();
    const credentialStatuses = vi
      .fn<OnboardingBridge["credentialStatuses"]>()
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new TypeError());
    const chatGptLogin = vi.fn(async () => ({
      status: "configured" as const,
      runtimeReady: true as const,
    }));
    const chatGptStatus = vi
      .fn<OnboardingBridge["chatGptStatus"]>()
      .mockResolvedValueOnce({ state: "absent", runtimeReady: false })
      .mockResolvedValueOnce({ state: "configured", runtimeReady: true });
    const bridge = twoProviderBridge({ credentialStatuses, chatGptLogin, chatGptStatus });
    const wizard = mountWizard({ bridge });
    await wizard.open();

    await user.click(screen.getByRole("button", { name: "Sign in with ChatGPT" }));

    await waitFor(() => {
      expect(credentialStatuses).toHaveBeenCalledTimes(2);
    });
    expect(document.body.textContent).toContain("ChatGPT is ready.");
    expect(document.body.textContent).not.toContain(
      "ChatGPT sign-in could not be completed. Please retry.",
    );
    wizard.controller.dispose();
  });
});
