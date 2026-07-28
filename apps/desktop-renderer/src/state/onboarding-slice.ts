import type { StateCreator } from "zustand";
import type { OnboardingActions, OnboardingSurfaceState } from "../onboarding/controller.js";
import { createOnboardingState } from "../onboarding/machine.js";
import { IDLE_RIDE_IMPORT } from "./ride-import-slice.js";
import type { EnduragentState } from "./store.js";

export const CLOSED_ONBOARDING: OnboardingSurfaceState = Object.freeze({
  open: false,
  wizard: createOnboardingState(),
  statuses: Object.freeze([]),
  configuration: null,
  draft: null,
  rideImport: IDLE_RIDE_IMPORT,
  focusSeq: 0,
});

export interface OnboardingSlice {
  readonly onboarding: OnboardingSurfaceState;
  readonly onboardingActions: OnboardingActions | null;
  setOnboarding: (next: OnboardingSurfaceState) => void;
  bindOnboardingActions: (actions: OnboardingActions | null) => void;
}

export const createOnboardingSlice: StateCreator<EnduragentState, [], [], OnboardingSlice> = (
  set,
) => ({
  onboarding: CLOSED_ONBOARDING,
  onboardingActions: null,
  setOnboarding(next) {
    set({ onboarding: next });
  },
  bindOnboardingActions(actions) {
    set({ onboardingActions: actions });
  },
});
