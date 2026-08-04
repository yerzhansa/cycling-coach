import {
  createRideImportController,
  type RideImportController,
  type RideImportState,
} from "../ride-import.js";
import type {
  CredentialWriteResult,
  OnboardingBridge,
  OnboardingLlmConfiguration,
  OnboardingLlmEndpointSelection,
  OnboardingLlmSelection,
} from "./bridge.js";
import {
  CUSTOM_MODEL_SELECTION,
  DESKTOP_CREDENTIAL_SLOTS,
  type DesktopCredentialSlot,
} from "./constants.js";
import { credentialPresentation } from "./credential-presentation.js";
import { handoffCredential, type CredentialDraftPort } from "./credentials.js";
import type { SetupCommit } from "./lanes.js";
import {
  createOnboardingState,
  hasTrainingData,
  intakeComplete,
  nextStep,
  toDesktopIntakeFlags,
  toOnboardingCompletion,
  withBusy,
  withChatGptLoginResult,
  withChatGptPending,
  withChatGptStatus,
  withClaudeCliStatus,
  withCredentialStatuses,
  withError,
  withImportedRideFileCount,
  withIntake,
  type ChatGptStatus,
  type CredentialSlotStatus,
  type DesktopIntakeDraft,
  type OnboardingCompletion,
  type OnboardingErrorCode,
  type OnboardingState,
} from "./machine.js";
import {
  draftForProvider,
  initialLlmDraft,
  llmSelectionFromDraft,
  type LlmSelectionDraft,
} from "./selection.js";

export interface OnboardingReadiness {
  readonly provider: boolean;
  readonly trainingData: boolean;
  readonly intake: boolean;
}

export interface OnboardingSurfaceState {
  readonly open: boolean;
  readonly wizard: OnboardingState;
  readonly statuses: readonly CredentialSlotStatus[];
  readonly configuration: OnboardingLlmConfiguration | null;
  readonly draft: LlmSelectionDraft | null;
  readonly rideImport: RideImportState;
  readonly focusSeq: number;
  readonly readiness: OnboardingReadiness;
  readonly lastCommit: SetupCommit;
}

export interface OnboardingView {
  render(surface: OnboardingSurfaceState): void;
}

export interface OnboardingActions {
  saveModelKey(): void;
  saveTrainingKey(): void;
  finish(): void;
  dismiss(): void;
  retrySavedKeys(): void;
  startChatGptLogin(): void;
  recheckClaudeCli(): void;
  chooseImportFiles(): void;
  selectProvider(provider: string): void;
  selectModel(model: string): void;
  setCustomModel(model: string): void;
  setEndpointMode(mode: string): void;
  setCustomEndpoint(endpoint: string): void;
  setIntake<Key extends keyof DesktopIntakeDraft>(key: Key, value: DesktopIntakeDraft[Key]): void;
}

export interface OnboardingController extends OnboardingActions {
  open(): Promise<void>;
  close(): void;
  dispose(): void;
  state(): OnboardingState;
  ownsDroppedImportFiles(): boolean;
  importDroppedFiles(paths: readonly string[]): void;
}

function credentialSlotFor(provider: string | undefined): DesktopCredentialSlot | undefined {
  return DESKTOP_CREDENTIAL_SLOTS.find((slot) => slot === provider);
}

export interface OnboardingControllerOptions {
  readonly bridge: OnboardingBridge;
  readonly credentials: CredentialDraftPort;
  readonly view: OnboardingView;
  readonly rideImports?: RideImportController;
  readonly onRideImportPresentationChange?: (presenting: boolean) => void;
  readonly focusOpener: () => void;
  readonly onComplete: (completion: OnboardingCompletion) => void;
}

type CredentialWriteRefusalReason = Extract<
  CredentialWriteResult,
  { readonly status: "refused" }
>["reason"];

const CREDENTIAL_WRITE_REFUSAL_ERRORS = {
  "invalid-input": "invalid-input",
  "encryption-unavailable": "encryption-unavailable",
  "unsafe-backend": "unsafe-backend",
  "storage-failed": "storage-failed",
  "runtime-unavailable": "runtime-unavailable",
  "training-account-mismatch": "training-account-mismatch",
} as const satisfies Readonly<Record<CredentialWriteRefusalReason, OnboardingErrorCode>>;

const ENDPOINT_MODES: readonly OnboardingLlmEndpointSelection["mode"][] = [
  "automatic",
  "default",
  "custom",
];

function credentialWriteRefusalError(reason: unknown): OnboardingErrorCode {
  if (typeof reason === "string" && Object.hasOwn(CREDENTIAL_WRITE_REFUSAL_ERRORS, reason)) {
    return CREDENTIAL_WRITE_REFUSAL_ERRORS[reason as CredentialWriteRefusalReason];
  }
  return "credential-save-failed";
}

export function credentialSlotStatus(
  surface: Pick<OnboardingSurfaceState, "statuses" | "wizard">,
  slot: DesktopCredentialSlot,
): CredentialSlotStatus {
  return (
    surface.statuses.find((entry) => entry.slot === slot) ?? {
      slot,
      state: surface.wizard.credentialStatus[slot],
      runtimeState: null,
    }
  );
}

export function createOnboardingController(
  options: OnboardingControllerOptions,
): OnboardingController {
  const rideImports = options.rideImports ?? createRideImportController(options.bridge);
  let state = createOnboardingState();
  let rideImportState: RideImportState = rideImports.state();
  let credentialStatuses: readonly CredentialSlotStatus[] = [];
  let presenting = false;
  let completed = false;
  let disposed = false;
  let opening = false;
  let visit = 0;
  let focusSeq = 0;
  let presentingRideImports = false;
  let llmConfiguration: OnboardingLlmConfiguration | undefined;
  let llmDraft: LlmSelectionDraft | undefined;
  let llmDrafts: Record<string, LlmSelectionDraft> = {};
  let lastCommit: SetupCommit = null;

  const publish = (): void => {
    options.view.render({
      open: presenting,
      wizard: state,
      statuses: credentialStatuses,
      configuration: llmConfiguration ?? null,
      draft: llmDraft ?? null,
      rideImport: rideImportState,
      focusSeq,
      readiness: {
        provider: selectedProviderIsReady(),
        trainingData: hasTrainingData(state),
        intake: intakeComplete(state.intake),
      },
      lastCommit,
    });
  };

  const focusTitle = (): void => {
    focusSeq += 1;
  };

  const setLlmDraft = (next: LlmSelectionDraft | undefined): void => {
    llmDraft = next;
    if (next !== undefined) llmDrafts[next.provider.provider] = next;
  };

  const setRideImportPresentation = (next: boolean): void => {
    if (presentingRideImports === next) return;
    presentingRideImports = next;
    options.onRideImportPresentationChange?.(next);
  };

  const status = (slot: DesktopCredentialSlot): CredentialSlotStatus =>
    credentialSlotStatus({ statuses: credentialStatuses, wizard: state }, slot);

  const setFixedError = (fixedError: OnboardingErrorCode | null): void => {
    state = { ...state, fixedError };
    publish();
  };

  const selectedProviderIsReady = (): boolean => {
    const provider = llmDraft?.provider.provider;
    if (provider === undefined) return false;
    if (llmConfiguration?.active?.provider === provider) return true;
    if (provider === "openai-codex") {
      return state.chatGptState === "configured" && state.chatGptRuntimeReady;
    }
    if (provider === "claude-cli") {
      return state.claudeCliState === "ready" || state.claudeCliState === "ready-api-key";
    }
    if (provider === "codex-agent") return false;
    return status(provider).state === "configured" && status(provider).runtimeState === "active";
  };

  const close = (): void => {
    visit += 1;
    options.credentials.clear();
    presenting = false;
    setRideImportPresentation(false);
    publish();
    options.focusOpener();
  };

  const loadClaudeCliStatus = (expectedVisit: number): void => {
    void options.bridge.claudeCliStatus().then(
      (status) => {
        if (disposed || visit !== expectedVisit || !presenting) return;
        state = withClaudeCliStatus(state, status);
        publish();
      },
      () => undefined,
    );
  };

  const refreshStatuses = async (expectedVisit: number): Promise<boolean> => {
    const [statuses, chatGpt] = await Promise.allSettled([
      options.bridge.credentialStatuses(),
      options.bridge.chatGptStatus(),
    ]);
    if (visit !== expectedVisit || !presenting) return false;
    if (statuses.status === "fulfilled") {
      credentialStatuses = statuses.value;
      state = withCredentialStatuses(state, statuses.value);
    }
    if (chatGpt.status === "fulfilled") {
      state = withChatGptStatus(state, chatGpt.value);
    } else if (
      statuses.status === "fulfilled" &&
      statuses.value.some(
        (entry) => entry.slot !== "intervals-icu" && entry.runtimeState === "active",
      )
    ) {
      state = { ...state, chatGptRuntimeReady: false };
    }
    return statuses.status === "fulfilled";
  };

  const savePasswordControls = async (
    expectedVisit: number,
    slots: readonly DesktopCredentialSlot[],
    selection?: OnboardingLlmSelection,
  ): Promise<{
    readonly error: OnboardingErrorCode | null;
    readonly selectedApplied: boolean;
  } | null> => {
    const controls = [...options.credentials.harvest(slots)];
    const selectedSlot = selection?.provider === "openai-codex" ? undefined : selection?.provider;
    controls.sort((left, right) => {
      const leftSelected = left.dataset.slot === selectedSlot ? 1 : 0;
      const rightSelected = right.dataset.slot === selectedSlot ? 1 : 0;
      return leftSelected - rightSelected;
    });
    let attempted = false;
    let selectedApplied = false;
    const outcome: {
      failure: OnboardingErrorCode | null;
      nonRuntimeFailure: OnboardingErrorCode | null;
    } = { failure: null, nonRuntimeFailure: null };
    const runtimeUnavailableSlots = new Set<DesktopCredentialSlot>();
    let statusRefreshFailed = false;
    for (const input of controls) {
      if (visit !== expectedVisit || !presenting) return null;
      try {
        if (input.value.trim().length === 0) continue;
        attempted = true;
        let configured = false;
        const appliesSelection = input.dataset.slot === selectedSlot;
        await handoffCredential(
          input,
          async (value) => {
            const result = await options.bridge.writeCredential(value);
            if (disposed || visit !== expectedVisit || !presenting) return;
            if (result.status === "configured") {
              configured = true;
              if (appliesSelection && result.runtimeReady) selectedApplied = true;
            } else {
              if (result.reason === "runtime-unavailable") {
                runtimeUnavailableSlots.add(result.slot);
              }
              const writeFailure = credentialWriteRefusalError(result.reason);
              outcome.failure ??= writeFailure;
              if (writeFailure !== "runtime-unavailable") {
                outcome.nonRuntimeFailure ??= writeFailure;
              }
            }
          },
          appliesSelection ? selection : undefined,
        );
        if (disposed || visit !== expectedVisit || !presenting) return null;
        if (!configured && outcome.failure === null) {
          outcome.failure = "credential-save-failed";
          outcome.nonRuntimeFailure ??= "credential-save-failed";
        }
      } catch {
        outcome.failure ??= "credential-save-failed";
        outcome.nonRuntimeFailure ??= "credential-save-failed";
      } finally {
        input.value = "";
      }
      if (disposed || visit !== expectedVisit || !presenting) return null;
    }
    if (attempted) {
      if (!(await refreshStatuses(expectedVisit))) {
        statusRefreshFailed = true;
      }
      if (disposed || visit !== expectedVisit || !presenting) return null;
    }
    if (statusRefreshFailed) {
      return {
        error: outcome.nonRuntimeFailure ?? "credential-status-unavailable",
        selectedApplied,
      };
    }
    if (runtimeUnavailableSlots.size === 0) {
      return { error: outcome.failure, selectedApplied };
    }
    if (outcome.nonRuntimeFailure !== null) {
      return { error: outcome.nonRuntimeFailure, selectedApplied };
    }
    const refreshedRuntimeStatuses = Array.from(runtimeUnavailableSlots, (slot) =>
      credentialStatuses.find((entry) => entry.slot === slot),
    );
    if (
      refreshedRuntimeStatuses.some(
        (entry) => entry === undefined || entry.state === "missing" || entry.state === "re-prompt",
      )
    ) {
      return { error: "credential-reenter-required", selectedApplied };
    }
    if (refreshedRuntimeStatuses.some((entry) => entry?.runtimeState === "failed")) {
      return { error: "runtime-unavailable", selectedApplied };
    }
    return { error: null, selectedApplied };
  };

  const hasRetryableCredential = (slot: DesktopCredentialSlot): boolean =>
    credentialStatuses.some(
      (entry) => entry.slot === slot && credentialPresentation(entry).retryable,
    );

  const saveModelKey = async (): Promise<void> => {
    if (disposed || !presenting || state.busy) return;
    const submitVisit = visit;
    lastCommit = "provider";
    state = withBusy(state, true);
    publish();
    const parsedSelection = llmSelectionFromDraft(llmDraft);
    if (parsedSelection.error !== null) {
      state = withError(state, parsedSelection.error);
      focusTitle();
      publish();
      return;
    }
    const slot = credentialSlotFor(parsedSelection.selection.provider);
    const saved = await savePasswordControls(
      submitVisit,
      slot === undefined ? [] : [slot],
      parsedSelection.selection,
    );
    if (visit !== submitVisit || !presenting) return;
    if (saved === null) return;
    let saveError = saved.error;
    if (saveError === "runtime-unavailable") saveError = "model-runtime-unavailable";
    if (saveError === null && !saved.selectedApplied) {
      try {
        const applied = await options.bridge.applyLlmSelection(parsedSelection.selection);
        if (visit !== submitVisit || !presenting) return;
        if (applied.status === "refused") {
          saveError =
            applied.reason === "credential-required"
              ? "credential-required"
              : applied.reason === "runtime-unavailable"
                ? "model-runtime-unavailable"
                : "invalid-input";
        } else {
          if (llmConfiguration !== undefined) {
            llmConfiguration = {
              ...llmConfiguration,
              active: {
                provider: parsedSelection.selection.provider,
                model: parsedSelection.selection.model,
              },
            };
          }
          if (!(await refreshStatuses(submitVisit))) {
            saveError = "credential-status-unavailable";
          }
        }
      } catch {
        if (visit !== submitVisit || !presenting) return;
        saveError = "model-runtime-unavailable";
      }
    }
    state = withBusy(state, false);
    if (saveError !== null) state = withError(state, saveError);
    else if (!selectedProviderIsReady()) state = withError(state, "model-runtime-unavailable");
    focusTitle();
    publish();
  };

  const saveTrainingKey = async (): Promise<void> => {
    if (disposed || !presenting || state.busy || rideImports.isBusy()) return;
    const submitVisit = visit;
    lastCommit = "training";
    state = withBusy(state, true);
    publish();
    const saved = await savePasswordControls(submitVisit, ["intervals-icu"]);
    if (visit !== submitVisit || !presenting) return;
    if (saved === null) return;
    const saveError = saved.error;
    state = withBusy(state, false);
    if (saveError !== null) state = withError(state, saveError);
    else if (hasRetryableCredential("intervals-icu")) {
      state = withError(state, "runtime-unavailable");
    } else if (!hasTrainingData(state)) state = withError(state, "training-data-required");
    focusTitle();
    publish();
  };

  const walkGates = (): OnboardingErrorCode | null => {
    let previous = state;
    let current = nextStep(previous, selectedProviderIsReady());
    if (current.step === previous.step) return current.fixedError ?? "credential-required";
    previous = current;
    current = nextStep(previous);
    if (current.step === previous.step) return current.fixedError ?? "training-data-required";
    previous = current;
    current = nextStep(previous);
    if (current.step === previous.step) return current.fixedError ?? "intake-incomplete";
    return current.step === "ready" ? null : "intake-incomplete";
  };

  const finishSetup = async (): Promise<void> => {
    if (disposed || !presenting || state.busy || rideImports.isBusy()) return;
    const gateError = walkGates();
    if (gateError !== null) {
      state = withError(state, gateError);
      focusTitle();
      publish();
      return;
    }
    const finishVisit = visit;
    state = withBusy(state, true);
    publish();
    let intake: ReturnType<typeof toDesktopIntakeFlags>;
    try {
      intake = toDesktopIntakeFlags(state.intake);
    } catch {
      state = withError(state, "intake-incomplete");
      focusTitle();
      publish();
      return;
    }
    try {
      await options.bridge.saveIntake(intake);
      if (visit !== finishVisit || !presenting) return;
    } catch {
      if (visit !== finishVisit || !presenting) return;
      state = withError(state, "intake-save-failed");
      focusTitle();
      publish();
      return;
    }
    state = withBusy(state, false);
    if (completed) {
      publish();
      return;
    }
    completed = true;
    visit += 1;
    presenting = false;
    setRideImportPresentation(false);
    publish();
    options.onComplete(toOnboardingCompletion(state));
  };

  const disposeImportState = rideImports.subscribe((next) => {
    rideImportState = next;
    if (next.status === "succeeded") {
      state = withImportedRideFileCount(state, rideImports.importedFileCount());
    } else if (next.status === "running" && next.owner === "onboarding") {
      state = { ...state, fixedError: null };
    }
    publish();
  });

  return {
    async open(): Promise<void> {
      if (disposed || presenting || opening) return;
      opening = true;
      const openVisit = ++visit;
      completed = false;
      lastCommit = null;
      let statuses: readonly CredentialSlotStatus[] = [];
      let restoredChatGptStatus: ChatGptStatus = { state: "absent", runtimeReady: false };
      const restored = await Promise.allSettled([
        options.bridge.credentialStatuses(),
        options.bridge.chatGptStatus(),
        options.bridge.llmConfiguration(),
      ]);
      if (restored[0].status === "fulfilled") statuses = restored[0].value;
      if (restored[1].status === "fulfilled") restoredChatGptStatus = restored[1].value;
      llmConfiguration = restored[2].status === "fulfilled" ? restored[2].value : undefined;
      llmDrafts = {};
      setLlmDraft(
        llmConfiguration === undefined
          ? undefined
          : initialLlmDraft(llmConfiguration, statuses, restoredChatGptStatus),
      );
      if (disposed || visit !== openVisit || presenting) {
        opening = false;
        return;
      }
      credentialStatuses = statuses;
      state = createOnboardingState(statuses, restoredChatGptStatus);
      if (llmDraft === undefined) state = withError(state, "configuration-unavailable");
      state = withImportedRideFileCount(state, rideImports.importedFileCount());
      presenting = true;
      setRideImportPresentation(true);
      focusTitle();
      publish();
      opening = false;
      loadClaudeCliStatus(openVisit);
    },
    close,
    dispose(): void {
      disposed = true;
      visit += 1;
      options.credentials.clear();
      presenting = false;
      setRideImportPresentation(false);
      publish();
      disposeImportState();
    },
    state: () => state,
    ownsDroppedImportFiles: () => !disposed && presenting,
    importDroppedFiles(paths) {
      if (!disposed && presenting && !state.busy && !rideImports.isBusy()) {
        void rideImports.importPaths("onboarding", paths);
      }
    },
    saveModelKey(): void {
      void saveModelKey();
    },
    saveTrainingKey(): void {
      void saveTrainingKey();
    },
    finish(): void {
      void finishSetup();
    },
    dismiss: close,
    retrySavedKeys(): void {
      if (disposed || !presenting || state.busy) return;
      const retryVisit = visit;
      state = withBusy(state, true);
      focusTitle();
      publish();
      void (async () => {
        try {
          const statuses = await options.bridge.retryFailedCredentials();
          if (visit !== retryVisit || !presenting) return;
          let nextState = withCredentialStatuses(state, statuses);
          try {
            nextState = withChatGptStatus(nextState, await options.bridge.chatGptStatus());
          } catch {
            nextState = { ...nextState, chatGptRuntimeReady: false };
          }
          if (visit !== retryVisit || !presenting) return;
          credentialStatuses = statuses;
          state = withBusy(nextState, false);
          focusTitle();
          publish();
        } catch {
          if (visit !== retryVisit || !presenting) return;
          state = withError(state, "runtime-unavailable");
          focusTitle();
          publish();
        }
      })();
    },
    startChatGptLogin(): void {
      if (disposed || !presenting || state.busy || state.chatGptState === "pending") return;
      if (llmDraft?.provider.provider !== "openai-codex") {
        const chatGpt = llmConfiguration?.providers.find(
          (provider) => provider.provider === "openai-codex",
        );
        if (chatGpt === undefined) {
          setFixedError("configuration-unavailable");
          return;
        }
        setLlmDraft(llmDrafts[chatGpt.provider] ?? draftForProvider(chatGpt));
      }
      const parsedSelection = llmSelectionFromDraft(llmDraft);
      if (parsedSelection.error !== null) {
        setFixedError(parsedSelection.error);
        return;
      }
      const loginVisit = visit;
      state = withChatGptPending(state);
      publish();
      void options.bridge.chatGptLogin(parsedSelection.selection).then(
        async (result) => {
          if (disposed || visit !== loginVisit || !presenting || state.chatGptState !== "pending") {
            return;
          }
          state = withChatGptLoginResult(state, result);
          if (result.status === "configured") {
            await refreshStatuses(loginVisit).catch(() => undefined);
          }
          if (disposed || visit !== loginVisit || !presenting) return;
          focusTitle();
          publish();
        },
        () => {
          if (disposed || visit !== loginVisit || !presenting || state.chatGptState !== "pending") {
            return;
          }
          state = withChatGptLoginResult(state, {
            status: "refused",
            reason: "exchange-failed",
          });
          focusTitle();
          publish();
        },
      );
    },
    recheckClaudeCli(): void {
      if (disposed || !presenting || state.busy) return;
      const recheckVisit = visit;
      state = withBusy(state, true);
      publish();
      void options.bridge.claudeCliRecheck().then(
        (status) => {
          if (disposed || visit !== recheckVisit || !presenting) return;
          state = withBusy(withClaudeCliStatus(state, status), false);
          publish();
        },
        () => {
          if (disposed || visit !== recheckVisit || !presenting) return;
          state = withBusy(state, false);
          publish();
        },
      );
    },
    chooseImportFiles(): void {
      if (disposed || !presenting || state.busy || rideImports.isBusy()) return;
      void rideImports.chooseAndImport("onboarding");
    },
    selectProvider(provider): void {
      const next = llmConfiguration?.providers.find((entry) => entry.provider === provider);
      if (next === undefined) return;
      setLlmDraft(llmDrafts[next.provider] ?? draftForProvider(next));
      setFixedError(null);
    },
    selectModel(model): void {
      if (llmDraft === undefined) return;
      setLlmDraft({
        ...llmDraft,
        modelChoice: model,
        customModel: model === CUSTOM_MODEL_SELECTION ? llmDraft.customModel : "",
      });
      setFixedError(null);
    },
    setCustomModel(model): void {
      if (llmDraft === undefined) return;
      setLlmDraft({ ...llmDraft, customModel: model });
      setFixedError(null);
    },
    setEndpointMode(mode): void {
      if (llmDraft === undefined) return;
      const parsed = ENDPOINT_MODES.find((candidate) => candidate === mode);
      if (parsed === undefined) return;
      setLlmDraft({ ...llmDraft, endpointMode: parsed });
      setFixedError(null);
    },
    setCustomEndpoint(endpoint): void {
      if (llmDraft === undefined) return;
      setLlmDraft({ ...llmDraft, customEndpoint: endpoint });
      setFixedError(null);
    },
    setIntake(key, value): void {
      state = withIntake(state, { [key]: value });
      publish();
    },
  };
}
