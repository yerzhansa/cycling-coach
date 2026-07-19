import { describe, expect, it } from "vitest";
import {
  canImportFiles,
  createOnboardingState,
  nextStep,
  previousStep,
  toDesktopIntakeFlags,
  withCredentialStatuses,
  withIntake,
  withSuccessfulImport,
} from "../src/onboarding/machine.js";

describe("desktop onboarding machine", () => {
  it("keeps the four ordered steps and exact guards", () => {
    let state = createOnboardingState();
    expect(Object.keys(state).sort()).toEqual([
      "acceptedImportPaths",
      "busy",
      "credentialStatus",
      "fixedError",
      "importProgress",
      "intake",
      "step",
    ]);
    expect(nextStep(state)).toMatchObject({
      step: "coach-keys",
      fixedError: "credential-required",
    });
    state = withCredentialStatuses(state, [
      { slot: "anthropic", state: "configured", runtimeReady: true },
    ]);
    state = nextStep(state);
    expect(state.step).toBe("training-data");
    expect(nextStep(state)).toMatchObject({
      step: "training-data",
      fixedError: "training-data-required",
    });
    state = withSuccessfulImport(state, ["/synthetic/ride.fit"]);
    state = nextStep(state);
    expect(state.step).toBe("safety-intake");
    expect(nextStep(state)).toMatchObject({
      step: "safety-intake",
      fixedError: "intake-incomplete",
    });
    state = withIntake(state, { priorBsi: false, injuryStatus: "none" });
    state = nextStep(state);
    expect(state.step).toBe("ready");
  });

  it("preserves configured metadata and successful imports while moving back", () => {
    let state = createOnboardingState([
      { slot: "openrouter", state: "configured", runtimeReady: true },
      { slot: "intervals-icu", state: "configured", runtimeReady: true },
    ]);
    state = nextStep(state);
    state = withSuccessfulImport(state, ["/synthetic/ride.tcx"]);
    state = nextStep(state);
    state = previousStep(state);
    state = previousStep(state);
    expect(state.step).toBe("coach-keys");
    expect(state.credentialStatus.openrouter).toBe("configured");
    expect(state.acceptedImportPaths).toEqual(["/synthetic/ride.tcx"]);
    expect("secret" in state).toBe(false);
  });

  it("accepts chooser and drop imports only while the training step is open and idle", () => {
    let state = createOnboardingState([
      { slot: "anthropic", state: "configured", runtimeReady: true },
    ]);
    state = nextStep(state);
    expect(canImportFiles(state, true)).toBe(true);
    expect(canImportFiles(state, false)).toBe(false);
    expect(canImportFiles({ ...state, busy: true }, true)).toBe(false);
    expect(canImportFiles(previousStep(state), true)).toBe(false);
  });

  it("maps every cycling intake branch to the landed strict DTO", () => {
    expect(
      toDesktopIntakeFlags({ priorBsi: false, injuryStatus: "none", clinicianCleared: null }),
    ).toEqual({
      swim_skill_floor: null,
      continuous_distance_capable: null,
      open_water_comfort: null,
      prior_bsi: false,
      clinician_cleared: null,
      injury_status: "none",
    });
    for (const priorBsi of [false, true]) {
      for (const injuryStatus of ["managing", "returning"] as const) {
        for (const clinicianCleared of [false, true]) {
          expect(toDesktopIntakeFlags({ priorBsi, injuryStatus, clinicianCleared })).toMatchObject({
            prior_bsi: priorBsi,
            injury_status: injuryStatus,
            clinician_cleared: clinicianCleared,
          });
        }
      }
    }
    expect(() =>
      toDesktopIntakeFlags({ priorBsi: true, injuryStatus: "none", clinicianCleared: null }),
    ).toThrow(TypeError);
  });
});
