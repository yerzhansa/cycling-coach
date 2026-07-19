import {
  SaveIntakeRpcParamsSchema,
  type CoachOperationProgressNotificationEnvelope,
  type SaveIntakeRpcParams,
} from "@enduragent/coach-contract";
import {
  DESKTOP_CREDENTIAL_SLOTS,
  ONBOARDING_STEP_IDS,
  type DesktopCredentialSlot,
  type OnboardingStepId,
} from "./constants.js";

export type CredentialState = "missing" | "configured" | "re-prompt";

export interface CredentialSlotStatus {
  readonly slot: DesktopCredentialSlot;
  readonly state: CredentialState;
  readonly runtimeReady: boolean;
}

export interface DesktopIntakeDraft {
  readonly priorBsi: boolean | null;
  readonly injuryStatus: "none" | "managing" | "returning" | null;
  readonly clinicianCleared: boolean | null;
}

export type OnboardingErrorCode =
  | "credential-required"
  | "credential-save-failed"
  | "training-data-required"
  | "import-failed"
  | "intake-incomplete"
  | "intake-save-failed";

export interface OnboardingState {
  readonly step: OnboardingStepId;
  readonly credentialStatus: Readonly<Record<DesktopCredentialSlot, CredentialState>>;
  readonly acceptedImportPaths: readonly string[];
  readonly importProgress: CoachOperationProgressNotificationEnvelope | null;
  readonly intake: DesktopIntakeDraft;
  readonly busy: boolean;
  readonly fixedError: OnboardingErrorCode | null;
}

export interface OnboardingCompletion {
  readonly providerConfigured: true;
  readonly trainingDataConfigured: true;
  readonly intakeSaved: true;
}

function statusRecord<T>(initial: T): Record<DesktopCredentialSlot, T> {
  return Object.fromEntries(DESKTOP_CREDENTIAL_SLOTS.map((slot) => [slot, initial])) as Record<
    DesktopCredentialSlot,
    T
  >;
}

export function createOnboardingState(
  statuses: readonly CredentialSlotStatus[] = [],
): OnboardingState {
  const credentialStatus = statusRecord<CredentialState>("missing");
  for (const status of statuses) {
    credentialStatus[status.slot] = status.state;
  }
  return {
    step: "coach-keys",
    credentialStatus,
    acceptedImportPaths: [],
    importProgress: null,
    intake: { priorBsi: null, injuryStatus: null, clinicianCleared: null },
    busy: false,
    fixedError: null,
  };
}

export function withCredentialStatuses(
  state: OnboardingState,
  statuses: readonly CredentialSlotStatus[],
): OnboardingState {
  const credentialStatus = { ...state.credentialStatus };
  for (const status of statuses) {
    credentialStatus[status.slot] = status.state;
  }
  return { ...state, credentialStatus };
}

export function hasConfiguredModel(state: OnboardingState): boolean {
  return DESKTOP_CREDENTIAL_SLOTS.some(
    (slot) => slot !== "intervals-icu" && state.credentialStatus[slot] === "configured",
  );
}

export function hasTrainingData(state: OnboardingState): boolean {
  return (
    state.credentialStatus["intervals-icu"] === "configured" || state.acceptedImportPaths.length > 0
  );
}

export function canImportFiles(state: OnboardingState, modalOpen: boolean): boolean {
  return modalOpen && !state.busy && state.step === "training-data";
}

export function toDesktopIntakeFlags(draft: DesktopIntakeDraft): SaveIntakeRpcParams {
  if (draft.priorBsi === null || draft.injuryStatus === null) throw new TypeError();
  const needsClearance = draft.priorBsi || draft.injuryStatus !== "none";
  if (needsClearance && draft.clinicianCleared === null) throw new TypeError();
  return SaveIntakeRpcParamsSchema.parse({
    swim_skill_floor: null,
    continuous_distance_capable: null,
    open_water_comfort: null,
    prior_bsi: draft.priorBsi,
    clinician_cleared: needsClearance ? draft.clinicianCleared : null,
    injury_status: draft.injuryStatus,
  });
}

export function nextStep(state: OnboardingState): OnboardingState {
  const index = ONBOARDING_STEP_IDS.indexOf(state.step);
  if (index >= ONBOARDING_STEP_IDS.length - 1) return state;
  if (state.step === "coach-keys" && !hasConfiguredModel(state)) {
    return { ...state, fixedError: "credential-required" };
  }
  if (state.step === "training-data" && !hasTrainingData(state)) {
    return { ...state, fixedError: "training-data-required" };
  }
  if (state.step === "safety-intake") {
    try {
      toDesktopIntakeFlags(state.intake);
    } catch {
      return { ...state, fixedError: "intake-incomplete" };
    }
  }
  return { ...state, step: ONBOARDING_STEP_IDS[index + 1]!, fixedError: null };
}

export function previousStep(state: OnboardingState): OnboardingState {
  const index = ONBOARDING_STEP_IDS.indexOf(state.step);
  if (index <= 0) return state;
  return { ...state, step: ONBOARDING_STEP_IDS[index - 1]!, fixedError: null };
}

export function withIntake(
  state: OnboardingState,
  update: Partial<DesktopIntakeDraft>,
): OnboardingState {
  const intake = { ...state.intake, ...update };
  const needsClearance =
    intake.priorBsi === true || (intake.injuryStatus !== null && intake.injuryStatus !== "none");
  return {
    ...state,
    intake: needsClearance ? intake : { ...intake, clinicianCleared: null },
    fixedError: null,
  };
}

export function withBusy(state: OnboardingState, busy: boolean): OnboardingState {
  return { ...state, busy, fixedError: busy ? null : state.fixedError };
}

export function withError(
  state: OnboardingState,
  fixedError: OnboardingErrorCode,
): OnboardingState {
  return { ...state, busy: false, fixedError };
}

export function withImportProgress(
  state: OnboardingState,
  importProgress: CoachOperationProgressNotificationEnvelope,
): OnboardingState {
  return { ...state, importProgress };
}

export function withSuccessfulImport(
  state: OnboardingState,
  paths: readonly string[],
): OnboardingState {
  return {
    ...state,
    acceptedImportPaths: [...paths],
    importProgress: null,
    busy: false,
    fixedError: null,
  };
}

export const ONBOARDING_COMPLETION: OnboardingCompletion = {
  providerConfigured: true,
  trainingDataConfigured: true,
  intakeSaved: true,
};
