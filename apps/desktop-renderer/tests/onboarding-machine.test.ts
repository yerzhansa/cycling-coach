import { describe, expect, it } from "vitest";
import {
  claudeCliReady,
  createOnboardingState,
  hasConfiguredModel,
  hasTrainingData,
  nextStep,
  previousStep,
  selectedProviderReady,
  toOnboardingCompletion,
  toDesktopIntakeFlags,
  withCredentialStatuses,
  withChatGptLoginResult,
  withChatGptPending,
  withChatGptStatus,
  withClaudeCliStatus,
  withIntake,
  withImportedRideFileCount,
} from "../src/onboarding/machine.js";

describe("desktop onboarding machine", () => {
  it("keeps the four ordered steps and exact guards", () => {
    let state = createOnboardingState();
    expect(Object.keys(state).sort()).toEqual([
      "busy",
      "chatGptRefusal",
      "chatGptRuntimeReady",
      "chatGptState",
      "claudeCliIdentity",
      "claudeCliState",
      "credentialRuntimeStatus",
      "credentialStatus",
      "fixedError",
      "importedRideFileCount",
      "intake",
      "step",
    ]);
    expect(nextStep(state)).toMatchObject({
      step: "coach-keys",
      fixedError: "credential-required",
    });
    state = withCredentialStatuses(state, [
      { slot: "anthropic", state: "configured", runtimeState: "active" },
    ]);
    state = nextStep(state);
    expect(state.step).toBe("training-data");
    expect(nextStep(state)).toMatchObject({
      step: "training-data",
      fixedError: "training-data-required",
    });
    state = withImportedRideFileCount(state, 1);
    state = nextStep(state);
    expect(state.step).toBe("safety-intake");
    expect(nextStep(state)).toMatchObject({
      step: "safety-intake",
      fixedError: "intake-incomplete",
    });
    state = withIntake(state, { injuryStatus: "none" });
    state = nextStep(state);
    expect(state.step).toBe("ready");
  });

  it("requires a runtime-ready restored or newly configured ChatGPT lane", () => {
    let state = createOnboardingState([], { state: "configured", runtimeReady: false });
    expect(hasConfiguredModel(state)).toBe(false);
    expect(nextStep(state).fixedError).toBe("credential-required");
    state = withChatGptStatus(state, { state: "configured", runtimeReady: true });
    expect(nextStep(state).step).toBe("training-data");
    state = createOnboardingState();
    state = withChatGptPending(state);
    expect(state).toMatchObject({ chatGptState: "pending", busy: true });
    state = withChatGptLoginResult(state, {
      status: "refused",
      reason: "callback-unavailable",
    });
    expect(state).toMatchObject({
      chatGptState: "refused",
      chatGptRefusal: "callback-unavailable",
      busy: false,
    });
    state = withChatGptLoginResult(state, { status: "configured", runtimeReady: true });
    expect(nextStep(state).step).toBe("training-data");
    state = withChatGptStatus(state, { state: "absent", runtimeReady: false });
    expect(state.chatGptState).toBe("absent");
  });

  it("requires the selected provider to match an active, healthy runtime", () => {
    const selection = { provider: "anthropic", model: "claude-sonnet-4-6" };
    const failed = createOnboardingState([
      { slot: "anthropic", state: "configured", runtimeState: "failed" },
    ]);

    expect(hasConfiguredModel(failed)).toBe(false);
    expect(selectedProviderReady(failed, selection, selection)).toBe(false);
    expect(
      selectedProviderReady(failed, selection, {
        provider: "openrouter",
        model: "deepseek/deepseek-v4-flash",
      }),
    ).toBe(false);

    const active = createOnboardingState([
      { slot: "anthropic", state: "configured", runtimeState: "active" },
    ]);
    expect(selectedProviderReady(active, selection, selection)).toBe(true);
    expect(
      selectedProviderReady(
        active,
        { provider: "anthropic", model: "athlete-selected-model" },
        selection,
      ),
    ).toBe(false);
  });

  it("rejects a failed training runtime but accepts imported ride data as the fallback", () => {
    let state = createOnboardingState([
      { slot: "intervals-icu", state: "configured", runtimeState: "failed" },
    ]);
    expect(hasTrainingData(state)).toBe(false);
    state = nextStep(state, true);
    expect(nextStep(state)).toMatchObject({
      step: "training-data",
      fixedError: "training-data-required",
    });

    state = withImportedRideFileCount(state, 1);
    expect(hasTrainingData(state)).toBe(true);
    expect(nextStep(state).step).toBe("safety-intake");
    expect(toOnboardingCompletion(state).requiresProviderSync).toBe(false);
  });

  it("treats only a probe-ready Claude subscription lane as a configured model", () => {
    let state = createOnboardingState([], { state: "absent", runtimeReady: false }, null);
    expect(state.claudeCliState).toBeNull();
    expect(state.claudeCliIdentity).toBeNull();
    expect(nextStep(state).fixedError).toBe("credential-required");

    state = withClaudeCliStatus(state, { state: "not-logged-in" });
    expect(claudeCliReady(state)).toBe(false);
    expect(nextStep(state).fixedError).toBe("credential-required");

    state = withClaudeCliStatus(state, {
      state: "ready",
      email: "athlete@example.test",
      plan: "Max",
    });
    expect(claudeCliReady(state)).toBe(true);
    expect(state.claudeCliIdentity).toBe(
      "Signed in as athlete@example.test - Claude Max subscription",
    );
    expect(nextStep(state).step).toBe("training-data");

    state = withClaudeCliStatus(state, { state: "ready-api-key" });
    expect(claudeCliReady(state)).toBe(true);
    expect(state.claudeCliIdentity).toBe(
      "Using Anthropic API key billing - usage is charged to your API account.",
    );

    state = withClaudeCliStatus(state, null);
    expect(state.claudeCliState).toBeNull();
    expect(claudeCliReady(state)).toBe(false);
  });

  it("preserves configured metadata and successful imports while moving back", () => {
    let state = createOnboardingState([
      { slot: "openrouter", state: "configured", runtimeState: "active" },
      { slot: "intervals-icu", state: "configured", runtimeState: "active" },
    ]);
    state = nextStep(state);
    state = withImportedRideFileCount(state, 1);
    state = nextStep(state);
    state = previousStep(state);
    state = previousStep(state);
    expect(state.step).toBe("coach-keys");
    expect(state.credentialStatus.openrouter).toBe("configured");
    expect(state.importedRideFileCount).toBe(1);
    expect("secret" in state).toBe(false);
  });

  it("preserves an earlier successful import when a later batch imports nothing", () => {
    let state = withImportedRideFileCount(createOnboardingState(), 2);
    state = withImportedRideFileCount(state, 0);
    expect(state.importedRideFileCount).toBe(2);
    expect(() => withImportedRideFileCount(state, -1)).toThrow(TypeError);
  });

  it("derives provider sync only from the configured training platform", () => {
    const fileOnly = withImportedRideFileCount(createOnboardingState(), 1);
    expect(toOnboardingCompletion(fileOnly)).toEqual({
      providerConfigured: true,
      trainingDataConfigured: true,
      intakeSaved: true,
      requiresProviderSync: false,
    });

    const platformOnly = createOnboardingState([
      { slot: "intervals-icu", state: "configured", runtimeState: "active" },
    ]);
    expect(toOnboardingCompletion(platformOnly).requiresProviderSync).toBe(true);

    const mixed = withImportedRideFileCount(platformOnly, 1);
    expect(toOnboardingCompletion(mixed).requiresProviderSync).toBe(true);
  });

  it("maps every cycling intake branch to the landed strict DTO", () => {
    expect(toDesktopIntakeFlags({ injuryStatus: "none", clinicianCleared: null })).toEqual({
      swim_skill_floor: null,
      continuous_distance_capable: null,
      open_water_comfort: null,
      prior_bsi: false,
      clinician_cleared: null,
      injury_status: "none",
    });
    for (const injuryStatus of ["managing", "returning"] as const) {
      for (const clinicianCleared of [false, true]) {
        expect(toDesktopIntakeFlags({ injuryStatus, clinicianCleared })).toMatchObject({
          injury_status: injuryStatus,
          clinician_cleared: clinicianCleared,
        });
      }
    }
    expect(() => toDesktopIntakeFlags({ injuryStatus: null, clinicianCleared: null })).toThrow(
      TypeError,
    );
    expect(() =>
      toDesktopIntakeFlags({ injuryStatus: "managing", clinicianCleared: null }),
    ).toThrow(TypeError);
  });
});
