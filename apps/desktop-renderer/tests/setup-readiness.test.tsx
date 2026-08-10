import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setupReady } from "../src/state/onboarding-slice.js";
import { useEnduragentStore } from "../src/state/store.js";
import { SetupPanel } from "../src/ui/onboarding/OnboardingWizard.js";
import {
  control,
  mountWizard,
  readyTelegramSettings,
  resetOnboardingStore,
  setTelegramSettings,
  testBridge,
} from "./onboarding-harness.js";

const savedIntake = {
  swim_skill_floor: null,
  continuous_distance_capable: null,
  open_water_comfort: null,
  prior_bsi: false,
  clinician_cleared: false,
  injury_status: "managing",
} as const;

describe("authoritative setup readiness", () => {
  afterEach(() => resetOnboardingStore());

  it("hydrates saved safety intake and accepts durable local rides without a training credential", async () => {
    const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
    bridge.getSetupStatus = vi.fn(async () => ({
      schemaVersion: 1 as const,
      intake: savedIntake,
      durableTrainingData: true,
    }));
    const wizard = mountWizard({ bridge });

    await wizard.open();

    expect(wizard.controller.state().intake).toEqual({
      injuryStatus: "managing",
      clinicianCleared: false,
    });
    expect(control<HTMLSelectElement>("onboarding-injury-status")).toHaveValue("managing");
    expect(control<HTMLSelectElement>("onboarding-clinician-cleared")).toHaveValue("no");
    expect(useEnduragentStore.getState().onboarding.readiness).toEqual({
      provider: true,
      trainingData: true,
      intake: true,
    });
    expect(setupReady(useEnduragentStore.getState())).toBe(true);
    wizard.controller.dispose();
  });

  it("fails closed while the durable setup read is still loading", async () => {
    let resolve!: (value: {
      schemaVersion: 1;
      intake: typeof savedIntake;
      durableTrainingData: boolean;
    }) => void;
    const pending = new Promise<{
      schemaVersion: 1;
      intake: typeof savedIntake;
      durableTrainingData: boolean;
    }>((settle) => {
      resolve = settle;
    });
    const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
    bridge.getSetupStatus = vi.fn(async () => pending);
    const wizard = mountWizard({ bridge });

    let opening!: Promise<void>;
    act(() => {
      opening = wizard.controller.open();
    });
    expect(useEnduragentStore.getState().onboarding.loading).toBe(true);
    expect(setupReady(useEnduragentStore.getState())).toBe(false);

    resolve({ schemaVersion: 1, intake: savedIntake, durableTrainingData: true });
    await act(async () => opening);
    expect(setupReady(useEnduragentStore.getState())).toBe(true);
    wizard.controller.dispose();
  });

  it("never counts or gates on Telegram in Chat but preserves other and Settings locks", async () => {
    setTelegramSettings(
      readyTelegramSettings({
        channel: { desiredState: "disabled", state: "disabled" },
        bot: { state: "unconfigured" },
        pairing: { state: "unpaired" },
        credentialConfigured: false,
        gapWarning: { state: "clear" },
      }),
    );
    const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
    bridge.getSetupStatus = vi.fn(async () => ({
      schemaVersion: 1 as const,
      intake: savedIntake,
      durableTrainingData: true,
    }));
    const wizard = mountWizard({ bridge });
    await wizard.open();

    act(() => {
      useEnduragentStore.setState({
        settings: { ...useEnduragentStore.getState().settings, savingOwners: ["telegram"] },
      });
    });
    expect(setupReady(useEnduragentStore.getState())).toBe(true);
    expect(screen.getByRole("button", { name: "Start coaching" })).toBeEnabled();
    expect(document.querySelector("[data-setup-readiness]")).toHaveTextContent(
      "3 of 3 required ready",
    );

    act(() => {
      useEnduragentStore.setState({
        settings: { ...useEnduragentStore.getState().settings, savingOwners: ["credential"] },
      });
    });
    expect(screen.getByRole("button", { name: "Start coaching" })).toBeDisabled();

    act(() => {
      useEnduragentStore.setState({
        settings: { ...useEnduragentStore.getState().settings, savingOwners: ["telegram"] },
      });
    });
    wizard.rendered.rerender(<SetupPanel placement="settings" />);
    expect(screen.queryByRole("button", { name: "Start coaching" })).toBeNull();
    expect(screen.queryByText("Everything stays on this Mac.")).toBeNull();
    expect(document.querySelector("[data-setup-readiness]")).toBeNull();
    wizard.controller.dispose();
  });

  it("keeps every setup control inert while authoritative status refreshes", async () => {
    let resolveRefresh!: (value: {
      schemaVersion: 1;
      intake: typeof savedIntake;
      durableTrainingData: boolean;
    }) => void;
    const refresh = new Promise<{
      schemaVersion: 1;
      intake: typeof savedIntake;
      durableTrainingData: boolean;
    }>((settle) => {
      resolveRefresh = settle;
    });
    const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
    const getSetupStatus = vi
      .fn()
      .mockResolvedValueOnce({
        schemaVersion: 1 as const,
        intake: savedIntake,
        durableTrainingData: true,
      })
      .mockImplementationOnce(async () => refresh);
    bridge.getSetupStatus = getSetupStatus;
    const wizard = mountWizard({ bridge });
    await wizard.open();

    let refreshing!: Promise<void>;
    act(() => {
      refreshing = wizard.controller.refresh();
    });

    const injury = control<HTMLSelectElement>("onboarding-injury-status");
    expect(injury).toBeDisabled();
    expect(control<HTMLButtonElement>("setup-panel-title").closest("section")).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(document.querySelector<HTMLButtonElement>('[data-setup-trigger="ai"]')).toBeDisabled();
    expect(
      document.querySelector<HTMLButtonElement>('[data-setup-trigger="training"]'),
    ).toBeDisabled();

    fireEvent.change(injury, { target: { value: "none" } });
    expect(wizard.controller.state().intake).toEqual({
      injuryStatus: "managing",
      clinicianCleared: false,
    });

    resolveRefresh({ schemaVersion: 1, intake: savedIntake, durableTrainingData: true });
    await act(async () => refreshing);
    expect(wizard.controller.state().intake).toEqual({
      injuryStatus: "managing",
      clinicianCleared: false,
    });
    wizard.controller.dispose();
  });

  it("shows unavailable setup status, disables controls, and recovers through Retry", async () => {
    const user = userEvent.setup();
    const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
    bridge.getSetupStatus = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("synthetic setup read failure"))
      .mockResolvedValueOnce({
        schemaVersion: 1 as const,
        intake: savedIntake,
        durableTrainingData: true,
      });
    const wizard = mountWizard({ bridge });
    await wizard.open();

    expect(useEnduragentStore.getState().onboarding.loadUnavailable).toBe(true);
    expect(setupReady(useEnduragentStore.getState())).toBe(false);
    expect(
      screen.getByText(
        "Setup status couldn’t be loaded. Check that Enduragent is running, then try again.",
      ),
    ).toBeInTheDocument();
    expect(document.querySelector<HTMLButtonElement>('[data-setup-trigger="ai"]')).toBeDisabled();
    expect(
      document.querySelector<HTMLButtonElement>('[data-setup-trigger="training"]'),
    ).toBeDisabled();
    expect(control<HTMLSelectElement>("onboarding-injury-status")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Start coaching" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Retry setup status" }));

    await waitFor(() => {
      expect(useEnduragentStore.getState().onboarding.loadUnavailable).toBe(false);
      expect(setupReady(useEnduragentStore.getState())).toBe(true);
    });
    expect(bridge.getSetupStatus).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("button", { name: "Retry setup status" })).toBeNull();
    expect(document.querySelector<HTMLButtonElement>('[data-setup-trigger="ai"]')).toBeEnabled();
    expect(
      document.querySelector<HTMLButtonElement>('[data-setup-trigger="training"]'),
    ).toBeEnabled();
    expect(control<HTMLSelectElement>("onboarding-injury-status")).toBeEnabled();
    wizard.controller.dispose();
  });

  it("retains unsaved provider and intake drafts across an unavailable refresh and retry", async () => {
    const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
    bridge.getSetupStatus = vi.fn(async () => ({
      schemaVersion: 1 as const,
      intake: savedIntake,
      durableTrainingData: true,
    }));
    const wizard = mountWizard({ bridge });
    await wizard.open();
    wizard.controller.selectProvider("openrouter");
    wizard.controller.selectModel("__custom__");
    wizard.controller.setCustomModel("vendor/unsaved-model");
    wizard.controller.setIntake("injuryStatus", "none");
    const draftBeforeFailure = useEnduragentStore.getState().onboarding.draft;
    const intakeBeforeFailure = wizard.controller.state().intake;
    bridge.llmConfiguration.mockRejectedValueOnce(new TypeError("synthetic catalogue failure"));

    await act(async () => wizard.controller.refresh());

    expect(useEnduragentStore.getState().onboarding.loadUnavailable).toBe(true);
    expect(useEnduragentStore.getState().onboarding.draft).toEqual(draftBeforeFailure);
    expect(wizard.controller.state().intake).toEqual(intakeBeforeFailure);

    await act(async () => wizard.controller.refresh());

    expect(useEnduragentStore.getState().onboarding.loadUnavailable).toBe(false);
    expect(useEnduragentStore.getState().onboarding.draft).toEqual(draftBeforeFailure);
    expect(wizard.controller.state().intake).toEqual(intakeBeforeFailure);
    wizard.controller.dispose();
  });

  it("blocks every credential mutation while repair is required without changing readiness", async () => {
    let repairRequired = false;
    const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
    bridge.getSetupStatus = vi.fn(async () => ({
      schemaVersion: 1 as const,
      intake: savedIntake,
      durableTrainingData: true,
    }));
    const wizard = mountWizard({
      bridge,
      credentialMutationsBlocked: () => repairRequired,
    });
    await wizard.open();
    expect(setupReady(useEnduragentStore.getState())).toBe(true);

    repairRequired = true;
    wizard.controller.saveModelKey();
    wizard.controller.saveTrainingKey();
    wizard.controller.retrySavedKeys();
    wizard.controller.startChatGptLogin();
    wizard.controller.retryChatGptActivation();
    wizard.controller.chooseImportFiles();
    wizard.controller.importDroppedFiles(["/tmp/synthetic.fit"]);
    wizard.controller.finish();

    await act(async () => Promise.resolve());
    expect(bridge.writeCredential).not.toHaveBeenCalled();
    expect(bridge.retryFailedCredentials).not.toHaveBeenCalled();
    expect(bridge.chatGptLogin).not.toHaveBeenCalled();
    expect(bridge.applyLlmSelection).not.toHaveBeenCalled();
    expect(bridge.chooseImportFiles).not.toHaveBeenCalled();
    expect(bridge.importFiles).not.toHaveBeenCalled();
    expect(bridge.saveIntake).not.toHaveBeenCalled();
    expect(wizard.controller.ownsDroppedImportFiles()).toBe(false);
    expect(setupReady(useEnduragentStore.getState())).toBe(true);
    wizard.controller.dispose();
  });

  it.each([
    [false, true, true, "provider"],
    [true, false, true, "trainingData"],
    [true, true, false, "intake"],
  ] as const)(
    "stays locked when provider=%s training=%s intake=%s",
    async (provider, training, intake, missing) => {
      const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
      bridge.chatGptStatus.mockResolvedValue({
        state: provider ? "configured" : "absent",
        runtimeReady: provider,
      });
      bridge.getSetupStatus = vi.fn(async () => ({
        schemaVersion: 1 as const,
        intake: intake ? savedIntake : null,
        durableTrainingData: training,
      }));
      const wizard = mountWizard({ bridge });
      await wizard.open();

      expect(useEnduragentStore.getState().onboarding.readiness[missing]).toBe(false);
      expect(setupReady(useEnduragentStore.getState())).toBe(false);
      wizard.controller.dispose();
    },
  );
});
