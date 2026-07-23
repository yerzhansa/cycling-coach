import { SaveIntakeRpcParamsSchema, type SaveIntakeRpcParams } from "@enduragent/coach-contract";
import {
  DESKTOP_CREDENTIAL_SLOTS,
  ONBOARDING_STEP_IDS,
  type DesktopCredentialSlot,
  type ChatGptLoginRefusalReason,
  type OnboardingStepId,
} from "./constants.js";

export type CredentialState = "missing" | "configured" | "re-prompt";
export type CredentialRuntimeState = "active" | "stored-inactive" | "failed";

export interface CredentialSlotStatus {
  readonly slot: DesktopCredentialSlot;
  readonly state: CredentialState;
  readonly runtimeState: CredentialRuntimeState | null;
}

export interface ChatGptStatus {
  readonly state: "configured" | "absent";
  readonly runtimeReady: boolean;
}

export type ChatGptLoginResult =
  | { readonly status: "configured"; readonly runtimeReady: true }
  | { readonly status: "refused"; readonly reason: ChatGptLoginRefusalReason };

export interface DesktopIntakeDraft {
  readonly priorBsi: boolean | null;
  readonly injuryStatus: "none" | "managing" | "returning" | null;
  readonly clinicianCleared: boolean | null;
}

export type OnboardingErrorCode =
  | "credential-required"
  | "credential-save-failed"
  | "invalid-input"
  | "encryption-unavailable"
  | "unsafe-backend"
  | "storage-failed"
  | "runtime-unavailable"
  | "credential-status-unavailable"
  | "credential-reenter-required"
  | "configuration-unavailable"
  | "model-selection-required"
  | "endpoint-invalid"
  | "model-runtime-unavailable"
  | "training-account-mismatch"
  | "training-data-required"
  | "intake-incomplete"
  | "intake-save-failed";

export interface OnboardingState {
  readonly step: OnboardingStepId;
  readonly credentialStatus: Readonly<Record<DesktopCredentialSlot, CredentialState>>;
  readonly chatGptState: "absent" | "pending" | "configured" | "refused";
  readonly chatGptRuntimeReady: boolean;
  readonly chatGptRefusal: ChatGptLoginRefusalReason | null;
  readonly importedRideFileCount: number;
  readonly intake: DesktopIntakeDraft;
  readonly busy: boolean;
  readonly fixedError: OnboardingErrorCode | null;
}

export interface OnboardingCompletion {
  readonly providerConfigured: true;
  readonly trainingDataConfigured: true;
  readonly intakeSaved: true;
  readonly requiresProviderSync: boolean;
}

function statusRecord<T>(initial: T): Record<DesktopCredentialSlot, T> {
  return Object.fromEntries(DESKTOP_CREDENTIAL_SLOTS.map((slot) => [slot, initial])) as Record<
    DesktopCredentialSlot,
    T
  >;
}

export function createOnboardingState(
  statuses: readonly CredentialSlotStatus[] = [],
  chatGptStatus: ChatGptStatus = { state: "absent", runtimeReady: false },
): OnboardingState {
  const credentialStatus = statusRecord<CredentialState>("missing");
  for (const status of statuses) {
    credentialStatus[status.slot] = status.state;
  }
  return {
    step: "coach-keys",
    credentialStatus,
    chatGptState: chatGptStatus.state,
    chatGptRuntimeReady: chatGptStatus.runtimeReady,
    chatGptRefusal: null,
    importedRideFileCount: 0,
    intake: { priorBsi: null, injuryStatus: null, clinicianCleared: null },
    busy: false,
    fixedError: null,
  };
}

export function withChatGptStatus(state: OnboardingState, status: ChatGptStatus): OnboardingState {
  return {
    ...state,
    chatGptState: status.state,
    chatGptRuntimeReady: status.runtimeReady,
    chatGptRefusal: null,
  };
}

export function withChatGptPending(state: OnboardingState): OnboardingState {
  return {
    ...state,
    chatGptState: "pending",
    chatGptRuntimeReady: false,
    chatGptRefusal: null,
    busy: true,
    fixedError: null,
  };
}

export function withChatGptLoginResult(
  state: OnboardingState,
  result: ChatGptLoginResult,
): OnboardingState {
  return result.status === "configured"
    ? {
        ...state,
        chatGptState: "configured",
        chatGptRuntimeReady: true,
        chatGptRefusal: null,
        busy: false,
        fixedError: null,
      }
    : {
        ...state,
        chatGptState: "refused",
        chatGptRuntimeReady: false,
        chatGptRefusal: result.reason,
        busy: false,
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
  return (
    state.chatGptState === "configured" ||
    DESKTOP_CREDENTIAL_SLOTS.some(
      (slot) => slot !== "intervals-icu" && state.credentialStatus[slot] === "configured",
    )
  );
}

export function hasTrainingData(state: OnboardingState): boolean {
  return (
    state.credentialStatus["intervals-icu"] === "configured" || state.importedRideFileCount > 0
  );
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

export function nextStep(
  state: OnboardingState,
  runtimeModelConfigured = hasConfiguredModel(state),
): OnboardingState {
  const index = ONBOARDING_STEP_IDS.indexOf(state.step);
  if (index >= ONBOARDING_STEP_IDS.length - 1) return state;
  if (state.step === "coach-keys" && !runtimeModelConfigured) {
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

export function withImportedRideFileCount(
  state: OnboardingState,
  importedRideFileCount: number,
): OnboardingState {
  if (!Number.isSafeInteger(importedRideFileCount) || importedRideFileCount < 0) {
    throw new TypeError();
  }
  return {
    ...state,
    importedRideFileCount: Math.max(state.importedRideFileCount, importedRideFileCount),
  };
}

export function toOnboardingCompletion(state: OnboardingState): OnboardingCompletion {
  return {
    providerConfigured: true,
    trainingDataConfigured: true,
    intakeSaved: true,
    requiresProviderSync: state.credentialStatus["intervals-icu"] === "configured",
  };
}
