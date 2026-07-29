import { randomUUID } from "node:crypto";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CredentialWriteResult, OnboardingBridge } from "../src/onboarding/bridge.js";
import { createRideImportController } from "../src/ride-import.js";
import {
  control,
  credentialBadge,
  errorText,
  importResult,
  mountWizard,
  passwordInput,
  resetOnboardingStore,
  retryButtons,
  seedSecret,
  testBridge,
  TEST_LLM_CONFIGURATION,
} from "./onboarding-harness.js";

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function button(name: string): HTMLButtonElement {
  return screen.getByRole("button", { name });
}

async function chooseOption(user: ReturnType<typeof userEvent.setup>, id: string, value: string) {
  await user.selectOptions(control<HTMLSelectElement>(id), value);
}

async function typeInto(user: ReturnType<typeof userEvent.setup>, id: string, value: string) {
  const element = control<HTMLInputElement>(id);
  await user.clear(element);
  await user.type(element, value);
}

type CredentialWriteRefusalReason = Extract<
  CredentialWriteResult,
  { readonly status: "refused" }
>["reason"];

const CREDENTIAL_REFUSAL_CASES = [
  {
    reason: "invalid-input",
    fixedError: "invalid-input",
    copy: "That key was not accepted. Check it and enter it again.",
  },
  {
    reason: "encryption-unavailable",
    fixedError: "encryption-unavailable",
    copy: "macOS encryption is unavailable. Make sure Keychain is available, then try again.",
  },
  {
    reason: "unsafe-backend",
    fixedError: "unsafe-backend",
    copy: "The app cannot safely store that key with the current storage backend.",
  },
  {
    reason: "storage-failed",
    fixedError: "storage-failed",
    copy: "The app could not confirm that key was saved securely. Check that secure storage is available and try again.",
  },
  {
    reason: "runtime-unavailable",
    fixedError: "model-runtime-unavailable",
    copy: "Your provider choice is saved, but it is not active yet. Choose Continue to retry it.",
  },
] as const satisfies ReadonlyArray<{
  readonly reason: CredentialWriteRefusalReason;
  readonly fixedError: CredentialWriteRefusalReason | "model-runtime-unavailable";
  readonly copy: string;
}>;

describe("mounted onboarding", () => {
  afterEach(() => {
    resetOnboardingStore();
  });

  it("presents the setup page, its progress hooks, and dismisses through the controller", async () => {
    const user = userEvent.setup();
    const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
    const wizard = mountWizard({ bridge });
    await wizard.open();

    const page = screen.getByRole("region", { name: "Setup" });
    expect(page).toHaveClass("onboarding");
    expect(control("onboarding-title")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.querySelector(".onboarding-scrim")).toBeNull();
    expect(screen.getByLabelText("Step 1 of 4")).toBeInTheDocument();
    expect(document.activeElement).toBe(control("onboarding-title"));

    await user.click(button("Dismiss"));

    expect(screen.queryByRole("region", { name: "Setup" })).toBeNull();
    expect(wizard.focusOpener).toHaveBeenCalledTimes(1);
    wizard.controller.dispose();
  });

  it("does not close the setup page on Escape", async () => {
    const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
    const wizard = mountWizard({ bridge });
    await wizard.open();

    const page = screen.getByRole("region", { name: "Setup" });
    expect(fireEvent.keyDown(page, { key: "Escape" })).toBe(true);

    expect(page).toBeInTheDocument();
    expect(wizard.focusOpener).not.toHaveBeenCalled();
    wizard.controller.dispose();
  });

  it("does not trap Tab inside the setup page", async () => {
    const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
    const wizard = mountWizard({ bridge });
    await wizard.open();

    const page = screen.getByRole("region", { name: "Setup" });
    const submit = button("Continue");
    expect(passwordInput("openai").closest("details")?.hasAttribute("open")).toBe(false);

    submit.focus();
    expect(fireEvent.keyDown(page, { key: "Tab" })).toBe(true);
    expect(document.activeElement).toBe(submit);
    wizard.controller.dispose();
  });

  it.each(CREDENTIAL_REFUSAL_CASES)(
    "keeps the athlete on coach keys and explains $reason refusals",
    async ({ reason, fixedError, copy }) => {
      const user = userEvent.setup();
      const bridge = testBridge(async () => ({ status: "configured", runtimeReady: true }));
      if (reason === "runtime-unavailable") {
        bridge.credentialStatuses
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([
            { slot: "anthropic", state: "configured", runtimeState: "failed" },
          ]);
      }
      let credentialWriteCount = 0;
      bridge.writeCredential.mockImplementation(async ({ slot }) => {
        credentialWriteCount += 1;
        return { slot, status: "refused", reason };
      });
      const onComplete = vi.fn();
      const wizard = mountWizard({ bridge, onComplete });
      await wizard.open();
      const secret = seedSecret("anthropic", randomUUID());

      await user.click(button("Continue"));

      await waitFor(() => {
        expect(wizard.controller.state().fixedError).toBe(fixedError);
      });
      expect(errorText()).toBe(copy);
      expect(wizard.controller.state().step).toBe("coach-keys");
      expect(secret.value).toBe("");
      expect(credentialWriteCount).toBe(1);
      expect(bridge.credentialStatuses).toHaveBeenCalledTimes(2);
      expect(onComplete).not.toHaveBeenCalled();
      wizard.controller.dispose();
    },
  );

  it("explains a training-account mismatch on the reachable intervals.icu path", async () => {
    const user = userEvent.setup();
    const bridge = testBridge(async () => ({ status: "configured", runtimeReady: true }));
    bridge.credentialStatuses.mockResolvedValue([
      { slot: "anthropic", state: "configured", runtimeState: "active" },
    ]);
    bridge.writeCredential.mockImplementation(async ({ slot }) => ({
      slot,
      status: "refused",
      reason: "training-account-mismatch",
    }));
    const wizard = mountWizard({ bridge });
    await wizard.open();

    await user.click(button("Continue"));
    await waitFor(() => {
      expect(wizard.controller.state().step).toBe("training-data");
    });
    seedSecret("intervals-icu", randomUUID());

    await user.click(button("Continue"));

    await waitFor(() => {
      expect(wizard.controller.state().fixedError).toBe("training-account-mismatch");
    });
    expect(errorText()).toBe(
      "That intervals.icu key belongs to a different athlete than the training history already stored. Switching accounts is not supported yet.",
    );
    expect(wizard.controller.state().step).toBe("training-data");
    expect(passwordInput("intervals-icu").value).toBe("");
    wizard.controller.dispose();
  });

  it("retries a saved provider choice with Continue without rewriting the key", async () => {
    const user = userEvent.setup();
    const bridge = testBridge(async () => ({ status: "configured", runtimeReady: true }));
    bridge.chatGptStatus.mockResolvedValue({ state: "absent", runtimeReady: false });
    bridge.credentialStatuses
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ slot: "anthropic", state: "configured", runtimeState: "failed" }])
      .mockResolvedValueOnce([{ slot: "anthropic", state: "configured", runtimeState: "active" }]);
    let credentialWriteCount = 0;
    bridge.writeCredential.mockImplementation(async ({ slot }) => {
      credentialWriteCount += 1;
      return { slot, status: "refused", reason: "runtime-unavailable" };
    });
    const onComplete = vi.fn();
    const wizard = mountWizard({ bridge, onComplete });
    await wizard.open();
    const secret = seedSecret("anthropic", randomUUID());

    await user.click(button("Continue"));

    await waitFor(() => {
      expect(wizard.controller.state().fixedError).toBe("model-runtime-unavailable");
    });
    expect(errorText()).toBe(
      "Your provider choice is saved, but it is not active yet. Choose Continue to retry it.",
    );
    expect(retryButtons()).toHaveLength(0);
    expect(secret.value).toBe("");
    expect(bridge.credentialStatuses).toHaveBeenCalledTimes(2);

    await user.click(button("Continue"));

    await waitFor(() => {
      expect(wizard.controller.state().step).toBe("training-data");
    });
    expect(bridge.applyLlmSelection).toHaveBeenCalledWith({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      endpoint: { mode: "automatic" },
    });
    expect(bridge.credentialStatuses).toHaveBeenCalledTimes(3);
    expect(credentialWriteCount).toBe(1);
    expect(bridge.retryFailedCredentials).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
    wizard.controller.dispose();
  });

  it("keeps Continue activation recovery available when applying the provider fails", async () => {
    const user = userEvent.setup();
    const bridge = testBridge(async () => ({ status: "configured", runtimeReady: true }));
    bridge.chatGptStatus.mockResolvedValue({ state: "absent", runtimeReady: false });
    bridge.credentialStatuses
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ slot: "anthropic", state: "configured", runtimeState: "failed" }]);
    bridge.applyLlmSelection.mockRejectedValue(new Error("private daemon failure"));
    bridge.writeCredential.mockImplementation(async ({ slot }) => ({
      slot,
      status: "refused",
      reason: "runtime-unavailable",
    }));
    const wizard = mountWizard({ bridge });
    await wizard.open();
    seedSecret("anthropic", randomUUID());

    await user.click(button("Continue"));
    await waitFor(() => {
      expect(wizard.controller.state().fixedError).toBe("model-runtime-unavailable");
    });

    await user.click(button("Continue"));

    await waitFor(() => {
      expect(wizard.controller.state().busy).toBe(false);
    });
    expect(wizard.controller.state().fixedError).toBe("model-runtime-unavailable");
    expect(errorText()).toBe(
      "Your provider choice is saved, but it is not active yet. Choose Continue to retry it.",
    );
    expect(retryButtons()).toHaveLength(0);
    expect(bridge.retryFailedCredentials).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("private daemon failure");
    wizard.controller.dispose();
  });

  it("offers intervals.icu recovery on training data without leaving or rewriting", async () => {
    const user = userEvent.setup();
    const failedStatuses = [
      { slot: "intervals-icu", state: "configured", runtimeState: "failed" },
    ] as const;
    const bridge = testBridge(async () => ({ status: "configured", runtimeReady: true }));
    bridge.credentialStatuses.mockResolvedValueOnce([]).mockResolvedValue(failedStatuses);
    bridge.retryFailedCredentials.mockResolvedValue(failedStatuses);
    let credentialWriteCount = 0;
    bridge.writeCredential.mockImplementation(async ({ slot }) => {
      credentialWriteCount += 1;
      return { slot, status: "refused", reason: "runtime-unavailable" };
    });
    const wizard = mountWizard({ bridge });
    await wizard.open();

    await user.click(button("Continue"));
    await waitFor(() => {
      expect(wizard.controller.state().step).toBe("training-data");
    });
    const intervals = seedSecret("intervals-icu", randomUUID());

    await user.click(button("Continue"));

    await waitFor(() => {
      expect(wizard.controller.state().fixedError).toBe("runtime-unavailable");
    });
    expect(wizard.controller.state().step).toBe("training-data");
    expect(errorText()).toBe(
      "That key was saved, but it is not active yet. Choose Retry saved keys to activate it.",
    );
    expect(retryButtons()).toHaveLength(1);
    expect(intervals.value).toBe("");

    await user.click(button("Back"));
    expect(wizard.controller.state().step).toBe("coach-keys");
    expect(retryButtons()).toHaveLength(0);

    await user.click(button("Continue"));
    await waitFor(() => {
      expect(wizard.controller.state().step).toBe("training-data");
    });
    expect(retryButtons()).toHaveLength(1);

    await user.click(button("Retry saved keys"));

    await waitFor(() => {
      expect(bridge.retryFailedCredentials).toHaveBeenCalledOnce();
    });
    await waitFor(() => {
      expect(wizard.controller.state().busy).toBe(false);
    });
    expect(wizard.controller.state().step).toBe("training-data");
    expect(retryButtons()).toHaveLength(1);
    expect(credentialWriteCount).toBe(1);
    expect(bridge.retryFailedCredentials).toHaveBeenCalledOnce();
    wizard.controller.dispose();
  });

  it("does not leak a late runtime-unavailable write into a reopened visit", async () => {
    const user = userEvent.setup();
    const bridge = testBridge(async () => ({ status: "configured", runtimeReady: true }));
    const pendingWrite = deferred<CredentialWriteResult>();
    let credentialWriteCount = 0;
    bridge.writeCredential.mockImplementation(() => {
      credentialWriteCount += 1;
      return pendingWrite.promise;
    });
    const wizard = mountWizard({ bridge });
    await wizard.open();
    seedSecret("anthropic", randomUUID());

    await user.click(button("Continue"));
    await waitFor(() => {
      expect(credentialWriteCount).toBe(1);
    });

    act(() => {
      wizard.controller.close();
    });
    pendingWrite.resolve({ slot: "anthropic", status: "refused", reason: "runtime-unavailable" });
    await pendingWrite.promise;
    await wizard.open();

    expect(wizard.controller.state()).toMatchObject({
      step: "coach-keys",
      busy: false,
      fixedError: null,
    });
    expect(retryButtons()).toHaveLength(0);
    expect(credentialWriteCount).toBe(1);
    wizard.controller.dispose();
  });

  it("snapshots and clears every password before the first write settles", async () => {
    const user = userEvent.setup();
    const firstValue = randomUUID();
    const secondValue = randomUUID();
    const firstWrite = deferred<void>();
    let firstValueMatched = false;
    let secondValueMatched = false;
    const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
    bridge.writeCredential.mockImplementation(async ({ slot, value }) => {
      if (slot === "anthropic") {
        firstValueMatched = value === firstValue;
        await firstWrite.promise;
      }
      if (slot === "openrouter") secondValueMatched = value === secondValue;
      return { slot, status: "configured", runtimeReady: true };
    });
    bridge.credentialStatuses
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ slot: "openrouter", state: "configured", runtimeState: "active" }]);
    const wizard = mountWizard({ bridge });
    await wizard.open();
    const firstInput = seedSecret("anthropic", firstValue);
    const secondInput = seedSecret("openrouter", secondValue);

    await user.click(button("Continue"));

    await waitFor(() => {
      expect(firstValueMatched).toBe(true);
    });
    expect(firstInput).toBeDisabled();
    expect(secondInput).toBeDisabled();
    expect(firstInput.value).toBe("");
    expect(secondInput.value).toBe("");
    expect(document.querySelector(".onboarding-action-status")?.textContent).toBe("Working…");
    secondInput.value = randomUUID();
    firstWrite.resolve();

    await waitFor(() => {
      expect(wizard.controller.state().step).toBe("training-data");
    });
    expect(secondValueMatched).toBe(true);
    expect(secondInput.value).toBe("");
    wizard.controller.dispose();
  });

  it("writes the explicitly selected provider last and attaches its model choice", async () => {
    const user = userEvent.setup();
    const anthropicKey = randomUUID();
    const openRouterKey = randomUUID();
    const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
    bridge.chatGptStatus.mockResolvedValue({ state: "absent", runtimeReady: false });
    bridge.credentialStatuses
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ slot: "openrouter", state: "configured", runtimeState: "active" }]);
    bridge.writeCredential.mockImplementation(async ({ slot, selection }) => ({
      slot,
      status: "configured",
      runtimeReady: selection !== undefined,
    }));
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await chooseOption(user, "onboarding-llm-provider", "openrouter");
    seedSecret("anthropic", anthropicKey);
    seedSecret("openrouter", openRouterKey);

    await user.click(button("Continue"));

    await waitFor(() => {
      expect(wizard.controller.state().step).toBe("training-data");
    });
    expect(bridge.writeCredential).toHaveBeenNthCalledWith(1, {
      slot: "anthropic",
      value: anthropicKey,
    });
    expect(bridge.writeCredential).toHaveBeenNthCalledWith(2, {
      slot: "openrouter",
      value: openRouterKey,
      selection: {
        provider: "openrouter",
        model: "deepseek/deepseek-v4-flash",
        endpoint: { mode: "automatic" },
      },
    });
    expect(bridge.applyLlmSelection).not.toHaveBeenCalled();
    wizard.controller.dispose();
  });

  it("applies a changed model for an active provider without a Desktop-owned key", async () => {
    const user = userEvent.setup();
    const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
    bridge.chatGptStatus.mockResolvedValue({ state: "absent", runtimeReady: false });
    bridge.llmConfiguration.mockResolvedValue({
      ...TEST_LLM_CONFIGURATION,
      active: { provider: "anthropic", model: "claude-sonnet-4-6" },
    });
    bridge.credentialStatuses.mockResolvedValue([]);
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await chooseOption(user, "onboarding-llm-model", "__custom__");
    await typeInto(user, "onboarding-custom-model", "athlete-selected-model");

    await user.click(button("Continue"));

    await waitFor(() => {
      expect(wizard.controller.state().step).toBe("training-data");
    });
    expect(bridge.writeCredential).not.toHaveBeenCalled();
    expect(bridge.applyLlmSelection).toHaveBeenCalledWith({
      provider: "anthropic",
      model: "athlete-selected-model",
      endpoint: { mode: "automatic" },
    });
    wizard.controller.dispose();
  });

  it("continues with an active ChatGPT profile without signing in again", async () => {
    const user = userEvent.setup();
    const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
    bridge.llmConfiguration.mockResolvedValue({
      ...TEST_LLM_CONFIGURATION,
      active: { provider: "openai-codex", model: "custom-chat-model" },
    });
    bridge.chatGptStatus.mockResolvedValue({ state: "configured", runtimeReady: true });
    const wizard = mountWizard({ bridge });
    await wizard.open();

    await user.click(button("Continue"));

    await waitFor(() => {
      expect(wizard.controller.state().step).toBe("training-data");
    });
    expect(bridge.chatGptLogin).not.toHaveBeenCalled();
    expect(bridge.applyLlmSelection).toHaveBeenCalledWith({
      provider: "openai-codex",
      model: "custom-chat-model",
      endpoint: { mode: "automatic" },
    });
    wizard.controller.dispose();
  });

  it("applies an endpoint change for an already-active provider without requiring the key again", async () => {
    const user = userEvent.setup();
    const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
    bridge.chatGptStatus.mockResolvedValue({ state: "absent", runtimeReady: false });
    bridge.llmConfiguration.mockResolvedValue({
      ...TEST_LLM_CONFIGURATION,
      active: { provider: "openrouter", model: "deepseek/deepseek-v4-flash" },
    });
    bridge.credentialStatuses.mockResolvedValue([
      { slot: "openrouter", state: "configured", runtimeState: "active" },
    ]);
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await chooseOption(user, "onboarding-endpoint-mode", "custom");
    await typeInto(user, "onboarding-custom-endpoint", "https://models.example.test/v1");

    await user.click(button("Continue"));

    await waitFor(() => {
      expect(wizard.controller.state().step).toBe("training-data");
    });
    expect(bridge.writeCredential).not.toHaveBeenCalled();
    expect(bridge.applyLlmSelection).toHaveBeenCalledWith({
      provider: "openrouter",
      model: "deepseek/deepseek-v4-flash",
      endpoint: { mode: "custom", value: "https://models.example.test/v1" },
    });
    wizard.controller.dispose();
  });

  it("freezes provider, model, and endpoint controls while applying a selection", async () => {
    const user = userEvent.setup();
    const pending = deferred<{ readonly status: "configured"; readonly runtimeReady: true }>();
    let active = false;
    const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
    bridge.chatGptStatus.mockResolvedValue({ state: "absent", runtimeReady: false });
    bridge.credentialStatuses.mockImplementation(async () => [
      {
        slot: "openrouter",
        state: "configured",
        runtimeState: active ? "active" : "stored-inactive",
      },
    ]);
    bridge.applyLlmSelection.mockImplementation(() => pending.promise);
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await chooseOption(user, "onboarding-llm-provider", "openrouter");

    await user.click(button("Continue"));

    await waitFor(() => {
      expect(bridge.applyLlmSelection).toHaveBeenCalledOnce();
    });
    expect(control("onboarding-llm-provider")).toBeDisabled();
    expect(control("onboarding-llm-model")).toBeDisabled();
    expect(control("onboarding-endpoint-mode")).toBeDisabled();

    active = true;
    pending.resolve({ status: "configured", runtimeReady: true });
    await waitFor(() => {
      expect(wizard.controller.state().step).toBe("training-data");
    });
    expect(bridge.applyLlmSelection).toHaveBeenCalledWith({
      provider: "openrouter",
      model: "deepseek/deepseek-v4-flash",
      endpoint: { mode: "automatic" },
    });
    wizard.controller.dispose();
  });

  it("does not submit the wizard when Enter is handled by a selection control", async () => {
    const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
    const wizard = mountWizard({ bridge });
    await wizard.open();
    const provider = control<HTMLSelectElement>("onboarding-llm-provider");

    expect(fireEvent.keyDown(provider, { key: "Enter" })).toBe(true);

    expect(bridge.applyLlmSelection).not.toHaveBeenCalled();
    expect(wizard.controller.state().busy).toBe(false);
    wizard.controller.dispose();
  });

  it("submits the wizard when Enter is pressed inside a credential field", async () => {
    const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
    bridge.chatGptStatus.mockResolvedValue({ state: "absent", runtimeReady: false });
    bridge.credentialStatuses.mockResolvedValue([
      { slot: "anthropic", state: "configured", runtimeState: "active" },
    ]);
    const wizard = mountWizard({ bridge });
    await wizard.open();

    expect(fireEvent.keyDown(passwordInput("anthropic"), { key: "Enter" })).toBe(false);

    await waitFor(() => {
      expect(wizard.controller.state().step).toBe("training-data");
    });
    wizard.controller.dispose();
  });

  it("retains a custom model and endpoint through provider switches and activation retry", async () => {
    const user = userEvent.setup();
    const secret = randomUUID();
    const selection = {
      provider: "openrouter" as const,
      model: "vendor/private-model",
      endpoint: { mode: "custom" as const, value: "https://models.example.test/v1" },
    };
    const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
    bridge.chatGptStatus.mockResolvedValue({ state: "absent", runtimeReady: false });
    bridge.credentialStatuses
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ slot: "openrouter", state: "configured", runtimeState: "failed" }])
      .mockResolvedValueOnce([{ slot: "openrouter", state: "configured", runtimeState: "active" }]);
    bridge.writeCredential.mockImplementation(async ({ slot }) => ({
      slot,
      status: "refused",
      reason: "runtime-unavailable",
    }));
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await chooseOption(user, "onboarding-llm-provider", "openrouter");
    await chooseOption(user, "onboarding-llm-model", "__custom__");
    await typeInto(user, "onboarding-custom-model", selection.model);
    await chooseOption(user, "onboarding-endpoint-mode", "custom");
    await typeInto(user, "onboarding-custom-endpoint", selection.endpoint.value);

    await chooseOption(user, "onboarding-llm-provider", "anthropic");
    await chooseOption(user, "onboarding-llm-provider", "openrouter");

    expect(control<HTMLSelectElement>("onboarding-llm-model").value).toBe("__custom__");
    expect(control<HTMLInputElement>("onboarding-custom-model").value).toBe(selection.model);
    expect(control<HTMLSelectElement>("onboarding-endpoint-mode").value).toBe("custom");
    expect(control<HTMLInputElement>("onboarding-custom-endpoint").value).toBe(
      selection.endpoint.value,
    );
    seedSecret("openrouter", secret);

    await user.click(button("Continue"));

    await waitFor(() => {
      expect(wizard.controller.state().fixedError).toBe("model-runtime-unavailable");
    });
    expect(bridge.writeCredential).toHaveBeenCalledWith({
      slot: "openrouter",
      value: secret,
      selection,
    });
    expect(passwordInput("openrouter").value).toBe("");
    expect(control<HTMLInputElement>("onboarding-custom-model").value).toBe(selection.model);
    expect(control<HTMLInputElement>("onboarding-custom-endpoint").value).toBe(
      selection.endpoint.value,
    );

    await user.click(button("Continue"));

    await waitFor(() => {
      expect(wizard.controller.state().step).toBe("training-data");
    });
    expect(bridge.applyLlmSelection).toHaveBeenCalledWith(selection);
    expect(bridge.writeCredential).toHaveBeenCalledTimes(1);
    wizard.controller.dispose();
  });

  it("blocks a non-loopback HTTP endpoint before invoking credential or runtime IPC", async () => {
    const user = userEvent.setup();
    const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await chooseOption(user, "onboarding-llm-provider", "openrouter");
    await chooseOption(user, "onboarding-endpoint-mode", "custom");
    await typeInto(user, "onboarding-custom-endpoint", "http://models.example.test/v1");
    seedSecret("openrouter", randomUUID());

    await user.click(button("Continue"));

    await waitFor(() => {
      expect(wizard.controller.state().fixedError).toBe("endpoint-invalid");
    });
    expect(bridge.writeCredential).not.toHaveBeenCalled();
    expect(bridge.applyLlmSelection).not.toHaveBeenCalled();
    wizard.controller.dispose();
  });

  it("passes the selected model to ChatGPT sign-in", async () => {
    const user = userEvent.setup();
    const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await chooseOption(user, "onboarding-llm-provider", "openai-codex");
    await chooseOption(user, "onboarding-llm-model", "__custom__");
    await typeInto(user, "onboarding-custom-model", "gpt-5.5-codex-max");

    await user.click(button("Sign in again"));

    await waitFor(() => {
      expect(bridge.chatGptLogin).toHaveBeenCalledOnce();
    });
    expect(bridge.chatGptLogin).toHaveBeenCalledWith({
      provider: "openai-codex",
      model: "gpt-5.5-codex-max",
      endpoint: { mode: "automatic" },
    });
    wizard.controller.dispose();
  });

  it.each([{ runtimeState: "active" }, { runtimeState: "stored-inactive" }] as const)(
    "recovers a selected provider from $runtimeState only after it is active",
    async (status) => {
      const user = userEvent.setup();
      const bridge = testBridge(async () => ({ status: "configured", runtimeReady: true }));
      bridge.chatGptStatus.mockResolvedValue({ state: "absent", runtimeReady: false });
      bridge.credentialStatuses
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          { slot: "anthropic", state: "configured", runtimeState: status.runtimeState },
        ])
        .mockResolvedValueOnce([
          { slot: "anthropic", state: "configured", runtimeState: "active" },
        ]);
      let credentialWriteCount = 0;
      bridge.writeCredential.mockImplementation(async ({ slot }) => {
        credentialWriteCount += 1;
        return { slot, status: "refused", reason: "runtime-unavailable" };
      });
      const wizard = mountWizard({ bridge });
      await wizard.open();
      seedSecret("anthropic", randomUUID());

      await user.click(button("Continue"));

      await waitFor(() => {
        expect(wizard.controller.state().step).toBe("training-data");
      });
      expect(wizard.controller.state().fixedError).toBeNull();
      expect(document.body.textContent).not.toContain(
        "That key was saved, but it is not active yet.",
      );
      expect(retryButtons()).toHaveLength(0);

      await user.click(button("Back"));

      expect(credentialBadge("anthropic").textContent).toBe("Configured");
      expect(retryButtons()).toHaveLength(0);
      expect(bridge.applyLlmSelection).toHaveBeenCalledOnce();
      expect(credentialWriteCount).toBe(1);
      wizard.controller.dispose();
    },
  );

  it("uses Continue instead of credential retry when an unrelated saved key failed", async () => {
    const user = userEvent.setup();
    const bridge = testBridge(async () => ({ status: "configured", runtimeReady: true }));
    bridge.chatGptStatus.mockResolvedValue({ state: "absent", runtimeReady: false });
    bridge.credentialStatuses.mockResolvedValueOnce([]).mockResolvedValue([
      { slot: "anthropic", state: "configured", runtimeState: "active" },
      { slot: "openrouter", state: "configured", runtimeState: "failed" },
    ]);
    let credentialWriteCount = 0;
    bridge.writeCredential.mockImplementation(async ({ slot }) => {
      credentialWriteCount += 1;
      return { slot, status: "refused", reason: "runtime-unavailable" };
    });
    const wizard = mountWizard({ bridge });
    await wizard.open();
    seedSecret("anthropic", randomUUID());
    seedSecret("openrouter", randomUUID());

    await user.click(button("Continue"));

    await waitFor(() => {
      expect(wizard.controller.state().fixedError).toBe("model-runtime-unavailable");
    });
    expect(wizard.controller.state().step).toBe("coach-keys");
    expect(retryButtons()).toHaveLength(0);

    await user.click(button("Continue"));

    await waitFor(() => {
      expect(wizard.controller.state().step).toBe("training-data");
    });
    expect(credentialWriteCount).toBe(2);
    wizard.controller.dispose();
  });

  it.each([
    { refreshedState: "re-prompt", description: "must be re-entered" },
    { refreshedState: "missing", description: "is reported missing" },
    { refreshedState: null, description: "is absent" },
  ] as const)("asks for the key again when the refreshed key $description", async (status) => {
    const user = userEvent.setup();
    const bridge = testBridge(async () => ({ status: "configured", runtimeReady: true }));
    bridge.chatGptStatus.mockResolvedValue({ state: "absent", runtimeReady: false });
    bridge.credentialStatuses
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(
        status.refreshedState === null
          ? []
          : [{ slot: "anthropic", state: status.refreshedState, runtimeState: null }],
      );
    bridge.writeCredential.mockImplementation(async ({ slot }) => ({
      slot,
      status: "refused",
      reason: "runtime-unavailable",
    }));
    const wizard = mountWizard({ bridge });
    await wizard.open();
    seedSecret("anthropic", randomUUID());

    await user.click(button("Continue"));

    await waitFor(() => {
      expect(wizard.controller.state()).toMatchObject({
        fixedError: "credential-reenter-required",
        credentialStatus: { anthropic: status.refreshedState ?? "missing" },
      });
    });
    expect(errorText()).toBe("That saved key could not be used. Enter it again to continue.");
    expect(retryButtons()).toHaveLength(0);
    wizard.controller.dispose();
  });

  it.each([
    { state: "configured", runtimeState: "stored-inactive" },
    { state: "re-prompt", runtimeState: null },
  ] as const)("does not offer retry for an unrelated $state status", async (status) => {
    const bridge = testBridge(async () => ({ status: "configured", runtimeReady: true }));
    bridge.chatGptStatus.mockResolvedValue({ state: "absent", runtimeReady: false });
    bridge.credentialStatuses.mockResolvedValue([
      { slot: "anthropic", state: status.state, runtimeState: status.runtimeState },
    ]);
    const wizard = mountWizard({ bridge });

    await wizard.open();

    expect(retryButtons()).toHaveLength(0);
    wizard.controller.dispose();
  });

  it("uses fixed generic copy when a credential write throws", async () => {
    const user = userEvent.setup();
    const exceptionDetail = "write exception detail must stay private";
    const bridge = testBridge(async () => ({ status: "configured", runtimeReady: true }));
    bridge.writeCredential.mockRejectedValue(new Error(exceptionDetail));
    const wizard = mountWizard({ bridge });
    await wizard.open();
    const secret = seedSecret("anthropic", randomUUID());

    await user.click(button("Continue"));

    await waitFor(() => {
      expect(wizard.controller.state().fixedError).toBe("credential-save-failed");
    });
    expect(errorText()).toBe("That key could not be saved. Try entering it again.");
    expect(document.body.textContent).not.toContain(exceptionDetail);
    expect(wizard.controller.state().step).toBe("coach-keys");
    expect(secret.value).toBe("");
    expect(bridge.credentialStatuses).toHaveBeenCalledTimes(2);
    wizard.controller.dispose();
  });

  it("explains when a saved key's post-write status cannot be refreshed", async () => {
    const user = userEvent.setup();
    const exceptionDetail = "status exception detail must stay private";
    const bridge = testBridge(async () => ({ status: "configured", runtimeReady: true }));
    bridge.credentialStatuses
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error(exceptionDetail));
    bridge.writeCredential.mockImplementation(async ({ slot }) => ({
      slot,
      status: "refused",
      reason: "runtime-unavailable",
    }));
    const wizard = mountWizard({ bridge });
    await wizard.open();
    const secret = seedSecret("anthropic", randomUUID());

    await user.click(button("Continue"));

    await waitFor(() => {
      expect(wizard.controller.state().fixedError).toBe("credential-status-unavailable");
    });
    expect(errorText()).toBe(
      "That key was saved, but its status could not be refreshed. Close and reopen Setup to check again.",
    );
    expect(document.body.textContent).not.toContain(exceptionDetail);
    expect(wizard.controller.state().step).toBe("coach-keys");
    expect(secret.value).toBe("");
    expect(bridge.credentialStatuses).toHaveBeenCalledTimes(2);
    wizard.controller.dispose();
  });

  it("accepts an active key when only the unrelated ChatGPT status refresh fails", async () => {
    const user = userEvent.setup();
    const exceptionDetail = "ChatGPT status detail must stay private";
    const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
    bridge.writeCredential.mockImplementation(async ({ slot }) => ({
      slot,
      status: "configured",
      runtimeReady: true,
    }));
    bridge.credentialStatuses
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ slot: "anthropic", state: "configured", runtimeState: "active" }]);
    bridge.chatGptStatus
      .mockResolvedValueOnce({ state: "configured", runtimeReady: true })
      .mockRejectedValueOnce(new Error(exceptionDetail));
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await chooseOption(user, "onboarding-llm-provider", "anthropic");
    seedSecret("anthropic", randomUUID());

    await user.click(button("Continue"));

    await waitFor(() => {
      expect(wizard.controller.state().step).toBe("training-data");
    });
    expect(wizard.controller.state().fixedError).toBeNull();
    expect(wizard.controller.state().chatGptRuntimeReady).toBe(false);
    expect(document.body.textContent).not.toContain(exceptionDetail);
    wizard.controller.dispose();
  });

  it("advances after a configured key write and refreshed active status", async () => {
    const user = userEvent.setup();
    const bridge = testBridge(async () => ({ status: "configured", runtimeReady: true }));
    bridge.chatGptStatus.mockResolvedValue({ state: "absent", runtimeReady: false });
    bridge.credentialStatuses
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ slot: "anthropic", state: "configured", runtimeState: "active" }]);
    let credentialWriteCount = 0;
    bridge.writeCredential.mockImplementation(async ({ slot }) => {
      credentialWriteCount += 1;
      return { slot, status: "configured", runtimeReady: true };
    });
    const onComplete = vi.fn();
    const wizard = mountWizard({ bridge, onComplete });
    await wizard.open();
    const secret = seedSecret("anthropic", randomUUID());

    await user.click(button("Continue"));

    await waitFor(() => {
      expect(wizard.controller.state().step).toBe("training-data");
    });
    expect(secret.value).toBe("");
    expect(credentialWriteCount).toBe(1);
    expect(bridge.credentialStatuses).toHaveBeenCalledTimes(2);
    expect(onComplete).not.toHaveBeenCalled();
    wizard.controller.dispose();
  });

  it("discloses distinct credential storage without starting sign-in, writing, or advancing", async () => {
    const bridge = testBridge(async () => ({ status: "configured", runtimeReady: true }));
    const wizard = mountWizard({ bridge });
    await wizard.open();
    const stateBeforeReading = wizard.controller.state();

    const disclosure = document.querySelector(".onboarding-copy");
    expect(disclosure?.textContent).toContain("ChatGPT sign-in is saved in a local profile file.");
    expect(disclosure?.textContent).toContain("API keys are encrypted by macOS.");
    expect(disclosure?.textContent).toContain(
      "The local coaching service uses your choice to contact the provider.",
    );

    expect(bridge.chatGptLogin).not.toHaveBeenCalled();
    expect(bridge.writeCredential).not.toHaveBeenCalled();
    expect(wizard.controller.state()).toEqual(stateBeforeReading);
    expect(wizard.controller.state().step).toBe("coach-keys");
    wizard.controller.dispose();
  });

  it("runs configured ChatGPT sign-in again through pending to configured", async () => {
    const user = userEvent.setup();
    const login = deferred<{ readonly status: "configured"; readonly runtimeReady: true }>();
    const bridge = testBridge(() => login.promise);
    const wizard = mountWizard({ bridge });
    await wizard.open();

    const signInAgain = button("Sign in again");
    expect(signInAgain.type).toBe("button");
    expect(signInAgain).toBeEnabled();
    await user.click(signInAgain);

    expect(bridge.chatGptLogin).toHaveBeenCalledTimes(1);
    expect(button("Finish signing in in your browser…")).toBeDisabled();
    act(() => {
      wizard.controller.startChatGptLogin();
    });
    expect(bridge.chatGptLogin).toHaveBeenCalledTimes(1);

    login.resolve({ status: "configured", runtimeReady: true });
    await waitFor(() => {
      expect(bridge.credentialStatuses).toHaveBeenCalledTimes(2);
      expect(bridge.chatGptStatus).toHaveBeenCalledTimes(2);
      expect(document.body.textContent).toContain("ChatGPT is ready.");
    });
    expect(button("Sign in again")).toBeEnabled();
    expect(bridge.writeCredential).not.toHaveBeenCalled();
    wizard.controller.dispose();
  });

  it("renders the existing refusal state after configured sign-in is refused", async () => {
    const user = userEvent.setup();
    const bridge = testBridge(async () => ({ status: "refused", reason: "timed-out" }));
    const wizard = mountWizard({ bridge });
    await wizard.open();

    await user.click(button("Sign in again"));

    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "ChatGPT sign-in timed out. Retry when you are ready.",
      );
    });
    expect(button("Retry ChatGPT sign-in")).toBeEnabled();
    wizard.controller.dispose();
  });

  it("owns drops only on the training-data step and gates on returned imported counts", async () => {
    const user = userEvent.setup();
    const bridge = testBridge(async () => ({ status: "configured", runtimeReady: true }));
    bridge.importFiles
      .mockResolvedValueOnce(importResult({ total: 2, imported: 1, quarantined: 1 }))
      .mockResolvedValueOnce(importResult({ total: 2, imported: 0, quarantined: 2 }));
    const wizard = mountWizard({ bridge });
    await wizard.open();
    expect(wizard.controller.ownsDroppedImportFiles()).toBe(false);
    expect(bridge.onDroppedImportFiles).not.toHaveBeenCalled();

    await user.click(button("Continue"));
    await waitFor(() => {
      expect(wizard.controller.ownsDroppedImportFiles()).toBe(true);
    });
    act(() => {
      wizard.controller.importDroppedFiles(["/synthetic/batch.fit"]);
    });
    await waitFor(() => {
      expect(bridge.importFiles).toHaveBeenCalledOnce();
    });
    await waitFor(() => {
      expect(wizard.controller.state().importedRideFileCount).toBe(1);
    });
    expect(document.body.textContent).toContain(
      "Local library import: 1 ride file imported. 1 ride file quarantined. Coaching access to activities and streams is available.",
    );

    act(() => {
      wizard.controller.importDroppedFiles(["/synthetic/quarantined.fit"]);
    });
    await waitFor(() => {
      expect(bridge.importFiles).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "Local library import failed. 0 ride files imported. 2 ride files quarantined. No new ride files are available for coaching.",
      );
    });
    expect(wizard.controller.state().importedRideFileCount).toBe(1);
    expect(document.body.textContent).not.toContain("Import completed");

    await user.click(button("Continue"));
    await waitFor(() => {
      expect(wizard.controller.state().step).toBe("safety-intake");
    });
    expect(wizard.controller.ownsDroppedImportFiles()).toBe(false);
    act(() => {
      wizard.controller.importDroppedFiles(["/synthetic/not-owned.fit"]);
    });
    expect(bridge.importFiles).toHaveBeenCalledTimes(2);
    act(() => {
      wizard.controller.close();
    });
    expect(wizard.controller.ownsDroppedImportFiles()).toBe(false);
    wizard.controller.dispose();
  });

  it("routes the ride file picker through the onboarding importer", async () => {
    const user = userEvent.setup();
    const bridge = testBridge(async () => ({ status: "configured", runtimeReady: true }));
    bridge.chooseImportFiles.mockResolvedValue(["/synthetic/chosen.fit"]);
    bridge.importFiles.mockResolvedValue(importResult({ total: 1, imported: 1, quarantined: 0 }));
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await user.click(button("Continue"));
    await waitFor(() => {
      expect(wizard.controller.state().step).toBe("training-data");
    });

    await user.click(screen.getByRole("button", { name: /Choose FIT, TCX, or GPX files/u }));

    await waitFor(() => {
      expect(bridge.chooseImportFiles).toHaveBeenCalledOnce();
    });
    await waitFor(() => {
      expect(bridge.importFiles).toHaveBeenCalledWith(["/synthetic/chosen.fit"], expect.anything());
    });
    await waitFor(() => {
      expect(wizard.controller.state().importedRideFileCount).toBe(1);
    });
    wizard.controller.dispose();
  });

  it.each([
    {
      source: "file-only",
      statuses: [],
      importRide: true,
      requiresProviderSync: false,
      readyCopy: "Ride files saved to your local library",
    },
    {
      source: "platform-only",
      statuses: [{ slot: "intervals-icu", state: "configured", runtimeState: "active" }] as const,
      importRide: false,
      requiresProviderSync: true,
      readyCopy: "Training data connected",
    },
    {
      source: "mixed",
      statuses: [{ slot: "intervals-icu", state: "configured", runtimeState: "active" }] as const,
      importRide: true,
      requiresProviderSync: true,
      readyCopy: "Training data connected",
    },
  ] as const)(
    "hands off the transient sync requirement for $source setup",
    async ({ statuses, importRide, requiresProviderSync, readyCopy }) => {
      const user = userEvent.setup();
      const bridge = testBridge(async () => ({ status: "configured", runtimeReady: true }));
      bridge.credentialStatuses.mockResolvedValue(statuses);
      bridge.importFiles.mockResolvedValue(importResult({ total: 1, imported: 1, quarantined: 0 }));
      const onComplete = vi.fn();
      const wizard = mountWizard({ bridge, onComplete });

      await wizard.open();
      await user.click(button("Continue"));
      await waitFor(() => {
        expect(wizard.controller.state().step).toBe("training-data");
      });
      if (importRide) {
        act(() => {
          wizard.controller.importDroppedFiles(["/synthetic/setup.fit"]);
        });
        await waitFor(() => {
          expect(wizard.controller.state().importedRideFileCount).toBe(1);
        });
      }
      await user.click(button("Continue"));
      await waitFor(() => {
        expect(wizard.controller.state().step).toBe("safety-intake");
      });
      await user.click(
        within(screen.getByRole("group", { name: "Have you had a bone stress injury?" })).getByRole(
          "radio",
          { name: "No" },
        ),
      );
      await user.click(screen.getByRole("radio", { name: "No current injury" }));
      await user.click(button("Continue"));
      await waitFor(() => {
        expect(wizard.controller.state().step).toBe("ready");
      });
      expect(
        Array.from(
          document.querySelector(".ready-preview")?.children ?? [],
          (child) => child.textContent,
        ),
      ).toEqual(["Keys secured", readyCopy, "Safety context saved"]);

      await user.click(button("Finish setup"));

      await waitFor(() => {
        expect(onComplete).toHaveBeenCalledOnce();
      });
      expect(onComplete).toHaveBeenCalledWith({
        providerConfigured: true,
        trainingDataConfigured: true,
        intakeSaved: true,
        requiresProviderSync,
      });
      wizard.controller.dispose();
    },
  );

  it("asks for clinician clearance once an injury history is recorded", async () => {
    const user = userEvent.setup();
    const bridge = testBridge(async () => ({ status: "configured", runtimeReady: true }));
    bridge.credentialStatuses.mockResolvedValue([
      { slot: "intervals-icu", state: "configured", runtimeState: "active" },
    ]);
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await user.click(button("Continue"));
    await waitFor(() => {
      expect(wizard.controller.state().step).toBe("training-data");
    });
    await user.click(button("Continue"));
    await waitFor(() => {
      expect(wizard.controller.state().step).toBe("safety-intake");
    });

    await user.click(
      within(screen.getByRole("group", { name: "Have you had a bone stress injury?" })).getByRole(
        "radio",
        { name: "Yes" },
      ),
    );
    await user.click(screen.getByRole("radio", { name: "No current injury" }));

    const clearance = screen.getByRole("group", {
      name: "Has a clinician cleared your current return to training?",
    });
    await user.click(button("Continue"));
    await waitFor(() => {
      expect(wizard.controller.state().fixedError).toBe("intake-incomplete");
    });
    expect(errorText()).toBe("Answer the required safety questions to continue.");
    expect(bridge.saveIntake).not.toHaveBeenCalled();

    await user.click(within(clearance).getByRole("radio", { name: "Yes" }));
    await user.click(button("Continue"));

    await waitFor(() => {
      expect(wizard.controller.state().step).toBe("ready");
    });
    expect(bridge.saveIntake).toHaveBeenCalledWith({
      swim_skill_floor: null,
      continuous_distance_capable: null,
      open_water_comfort: null,
      prior_bsi: true,
      clinician_cleared: true,
      injury_status: "none",
    });
    wizard.controller.dispose();
  });

  it("keeps the athlete on the safety step when the intake write fails", async () => {
    const user = userEvent.setup();
    const bridge = testBridge(async () => ({ status: "configured", runtimeReady: true }));
    bridge.credentialStatuses.mockResolvedValue([
      { slot: "intervals-icu", state: "configured", runtimeState: "active" },
    ]);
    bridge.saveIntake.mockRejectedValue(new Error("intake detail must stay private"));
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await user.click(button("Continue"));
    await waitFor(() => {
      expect(wizard.controller.state().step).toBe("training-data");
    });
    await user.click(button("Continue"));
    await waitFor(() => {
      expect(wizard.controller.state().step).toBe("safety-intake");
    });
    await user.click(
      within(screen.getByRole("group", { name: "Have you had a bone stress injury?" })).getByRole(
        "radio",
        { name: "No" },
      ),
    );
    await user.click(screen.getByRole("radio", { name: "No current injury" }));

    await user.click(button("Continue"));

    await waitFor(() => {
      expect(wizard.controller.state().fixedError).toBe("intake-save-failed");
    });
    expect(errorText()).toBe("Your answers could not be saved. Please try again.");
    expect(wizard.controller.state().step).toBe("safety-intake");
    expect(document.body.textContent).not.toContain("intake detail must stay private");
    wizard.controller.dispose();
  });

  it("does not start a dropped import while the training-data step is submitting", async () => {
    const user = userEvent.setup();
    const bridge = testBridge(async () => ({ status: "configured", runtimeReady: true }));
    const pendingWrite = deferred<CredentialWriteResult>();
    let credentialWriteCount = 0;
    bridge.writeCredential.mockImplementation(() => {
      credentialWriteCount += 1;
      return pendingWrite.promise;
    });
    const wizard = mountWizard({ bridge });
    await wizard.open();

    await user.click(button("Continue"));
    await waitFor(() => {
      expect(wizard.controller.ownsDroppedImportFiles()).toBe(true);
    });
    seedSecret("intervals-icu", randomUUID());

    await user.click(button("Continue"));
    await waitFor(() => {
      expect(credentialWriteCount).toBe(1);
    });
    act(() => {
      wizard.controller.importDroppedFiles(["/synthetic/during-submit.fit"]);
    });
    expect(bridge.importFiles).not.toHaveBeenCalled();

    pendingWrite.resolve({ slot: "intervals-icu", status: "configured", runtimeReady: true });
    await waitFor(() => {
      expect(wizard.controller.state().busy).toBe(false);
    });
    wizard.controller.dispose();
  });

  it("presents resident-routed import outcomes while another onboarding step is open", async () => {
    const bridge = testBridge(async () => ({ status: "configured", runtimeReady: true }));
    bridge.importFiles.mockResolvedValue(importResult({ total: 2, imported: 1, quarantined: 1 }));
    const presentationChanges = vi.fn();
    const imports = createRideImportController(bridge as OnboardingBridge);
    const wizard = mountWizard({
      bridge,
      rideImports: imports,
      onRideImportPresentationChange: presentationChanges,
    });

    await wizard.open();
    expect(wizard.controller.state().step).toBe("coach-keys");
    expect(presentationChanges).toHaveBeenLastCalledWith(true);
    await act(async () => {
      await imports.importPaths("resident", ["/synthetic/outside-training.fit"]);
    });
    expect(document.body.textContent).toContain(
      "Local library import: 1 ride file imported. 1 ride file quarantined. Coaching access to activities and streams is available.",
    );

    act(() => {
      wizard.controller.close();
    });
    expect(presentationChanges).toHaveBeenLastCalledWith(false);
    wizard.controller.dispose();
  });
});
