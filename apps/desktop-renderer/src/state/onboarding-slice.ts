import type { StateCreator } from "zustand";
import type { OnboardingController, OnboardingSurfaceState } from "../onboarding/controller.js";
import { createOnboardingState } from "../onboarding/machine.js";
import { repairRequiredCredential } from "../settings/credential-controller.js";
import { IDLE_RIDE_IMPORT } from "./ride-import-slice.js";
import type { EnduragentState } from "./store.js";

export const CLOSED_ONBOARDING: OnboardingSurfaceState = Object.freeze({
  open: false,
  initialized: false,
  loading: true,
  loadUnavailable: false,
  hasSuccessfulLoad: false,
  completionRequired: false,
  wizard: createOnboardingState(),
  statuses: Object.freeze([]),
  configuration: null,
  draft: null,
  rideImport: IDLE_RIDE_IMPORT,
  focusSeq: 0,
  readiness: Object.freeze({ provider: false, trainingData: false, intake: false }),
  lastCommit: null,
  actionStatus: null,
});

export const READY_ONBOARDING: OnboardingSurfaceState = Object.freeze({
  ...CLOSED_ONBOARDING,
  initialized: true,
  loading: false,
  hasSuccessfulLoad: true,
  readiness: Object.freeze({ provider: true, trainingData: true, intake: true }),
});

export interface OnboardingSlice {
  readonly onboarding: OnboardingSurfaceState;
  readonly onboardingActions: OnboardingController | null;
  readonly onboardingStartupSettled: boolean;
  setOnboarding: (next: OnboardingSurfaceState) => void;
  bindOnboardingActions: (actions: OnboardingController | null) => void;
  setOnboardingStartupSettled: (settled: boolean) => void;
}

export function setupReady(state: Pick<EnduragentState, "onboarding" | "settings">): boolean {
  return setupDisposition(state) === "satisfied";
}

export type SetupDisposition = "unknown" | "required" | "satisfied";

export function setupDisposition(
  state: Pick<EnduragentState, "onboarding" | "settings">,
): SetupDisposition {
  if (!state.onboarding.initialized) return "unknown";
  if (
    state.onboarding.completionRequired ||
    repairRequiredCredential(state.settings.credentials) !== null
  ) {
    return "required";
  }
  if (!state.onboarding.hasSuccessfulLoad) {
    return state.onboarding.loadUnavailable ? "required" : "unknown";
  }
  return "satisfied";
}

export function setupRequired(state: Pick<EnduragentState, "onboarding" | "settings">): boolean {
  return setupDisposition(state) === "required";
}

export function setupBlocked(state: Pick<EnduragentState, "onboarding" | "settings">): boolean {
  return setupDisposition(state) !== "satisfied";
}

export const createOnboardingSlice: StateCreator<EnduragentState, [], [], OnboardingSlice> = (
  set,
) => ({
  onboarding: CLOSED_ONBOARDING,
  onboardingActions: null,
  onboardingStartupSettled: false,
  setOnboarding(next) {
    set({ onboarding: next });
  },
  bindOnboardingActions(actions) {
    set({ onboardingActions: actions });
  },
  setOnboardingStartupSettled(settled) {
    set({ onboardingStartupSettled: settled });
  },
});
