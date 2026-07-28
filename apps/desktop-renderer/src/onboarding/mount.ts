import {
  ADVANCED_MODEL_CREDENTIAL_SLOTS,
  CUSTOM_MODEL_SELECTION,
  INTERVALS_GUIDANCE,
  ONBOARDING_LLM_PROVIDER_LABELS,
  ONBOARDING_STEP_IDS,
  PRIMARY_MODEL_CREDENTIAL_SLOTS,
  type DesktopCredentialSlot,
  type ModelCredentialSlot,
} from "./constants.js";
import type {
  CredentialWriteResult,
  OnboardingBridge,
  OnboardingCredentialWriteInput,
  OnboardingLlmConfiguration,
  OnboardingLlmEndpointSelection,
  OnboardingLlmProviderConfiguration,
  OnboardingLlmSelection,
} from "./bridge.js";
import { credentialPresentation } from "./credential-presentation.js";
import {
  createOnboardingState,
  hasTrainingData,
  nextStep,
  previousStep,
  toOnboardingCompletion,
  toDesktopIntakeFlags,
  withBusy,
  withChatGptLoginResult,
  withChatGptPending,
  withChatGptStatus,
  withCredentialStatuses,
  withError,
  withImportedRideFileCount,
  withIntake,
  type CredentialSlotStatus,
  type ChatGptStatus,
  type OnboardingCompletion,
  type OnboardingErrorCode,
  type OnboardingState,
} from "./machine.js";
import {
  createRideImportController,
  rideImportStatusCopy,
  type RideImportController,
  type RideImportState,
} from "../ride-import.js";

export interface OnboardingController {
  open(): Promise<void>;
  close(): void;
  dispose(): void;
  state(): OnboardingState;
  ownsDroppedImportFiles(): boolean;
  importDroppedFiles(paths: readonly string[]): void;
}

interface MountOnboardingOptions {
  readonly document: Document;
  readonly bridge: OnboardingBridge;
  readonly rideImports?: RideImportController;
  readonly onRideImportPresentationChange?: (presenting: boolean) => void;
  readonly opener: Pick<HTMLElement, "focus">;
  readonly onComplete: (completion: OnboardingCompletion) => void;
}

export interface TransientPasswordInput {
  value: string;
  readonly dataset: { readonly slot?: string };
}

export async function handoffCredential(
  input: TransientPasswordInput,
  write: (value: OnboardingCredentialWriteInput) => Promise<unknown>,
  selection?: OnboardingLlmSelection,
): Promise<boolean> {
  let secret: string | undefined;
  try {
    secret = input.value;
    input.value = "";
    if (secret.trim().length === 0) return false;
    await write({
      slot: input.dataset.slot as DesktopCredentialSlot,
      value: secret,
      ...(selection === undefined ? {} : { selection }),
    });
    return true;
  } finally {
    input.value = "";
    secret = undefined;
  }
}

const ERROR_COPY: Readonly<Record<OnboardingErrorCode, string>> = {
  "credential-required": "Sign in with ChatGPT or add at least one model key to continue.",
  "credential-save-failed": "That key could not be saved. Try entering it again.",
  "invalid-input": "That key was not accepted. Check it and enter it again.",
  "encryption-unavailable":
    "macOS encryption is unavailable. Make sure Keychain is available, then try again.",
  "unsafe-backend": "The app cannot safely store that key with the current storage backend.",
  "storage-failed":
    "The app could not confirm that key was saved securely. Check that secure storage is available and try again.",
  "runtime-unavailable":
    "That key was saved, but it is not active yet. Choose Retry saved keys to activate it.",
  "credential-status-unavailable":
    "That key was saved, but its status could not be refreshed. Close and reopen Setup to check again.",
  "credential-reenter-required": "That saved key could not be used. Enter it again to continue.",
  "configuration-unavailable":
    "Coach choices are unavailable right now. Close and reopen Setup to try again.",
  "model-selection-required": "Choose a model or enter a custom model name.",
  "endpoint-invalid": "Enter a valid HTTPS endpoint, or a loopback HTTP endpoint.",
  "model-runtime-unavailable":
    "Your provider choice is saved, but it is not active yet. Choose Continue to retry it.",
  "training-account-mismatch":
    "That intervals.icu key belongs to a different athlete than the training history already stored. Switching accounts is not supported yet.",
  "training-data-required": "Connect intervals.icu or import at least one ride file.",
  "intake-incomplete": "Answer the required safety questions to continue.",
  "intake-save-failed": "Your answers could not be saved. Please try again.",
};

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

function credentialWriteRefusalError(reason: unknown): OnboardingErrorCode {
  if (typeof reason === "string" && Object.hasOwn(CREDENTIAL_WRITE_REFUSAL_ERRORS, reason)) {
    return CREDENTIAL_WRITE_REFUSAL_ERRORS[reason as CredentialWriteRefusalReason];
  }
  return "credential-save-failed";
}

const CHATGPT_REFUSAL_COPY = {
  "already-in-progress": "A ChatGPT sign-in is already in progress.",
  "callback-unavailable":
    "The local sign-in callback is unavailable. Close other sign-in flows and retry.",
  "timed-out": "ChatGPT sign-in timed out. Retry when you are ready.",
  cancelled: "ChatGPT sign-in was cancelled. You can retry.",
  "exchange-failed": "ChatGPT sign-in could not be completed. Please retry.",
  "storage-failed": "ChatGPT sign-in completed, but the profile could not be saved.",
  "runtime-unavailable": "ChatGPT sign-in was saved, but the coach could not be configured.",
} as const;

function make<K extends keyof HTMLElementTagNameMap>(
  document: Document,
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function focusableElements(root: HTMLElement): readonly HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => {
    if (element.hasAttribute("hidden")) return false;
    const closedDetails = element.closest("details:not([open])");
    return closedDetails === null || element.tagName === "SUMMARY";
  });
}

function passwordControl(
  document: Document,
  slot: ModelCredentialSlot | "intervals-icu",
  labelText: string,
  status: CredentialSlotStatus,
  disabled = false,
): HTMLElement {
  const presentation = credentialPresentation(status);
  const field = make(document, "div", "credential-field");
  const label = make(document, "label", "credential-label");
  const id = `credential-${slot}`;
  label.htmlFor = id;
  label.append(document.createTextNode(labelText));
  const badge = make(
    document,
    "span",
    `credential-state ${presentation.className}`,
    presentation.copy,
  );
  label.append(badge);
  const input = make(document, "input");
  input.id = id;
  input.type = "password";
  input.autocomplete = "off";
  input.disabled = disabled;
  input.dataset.slot = slot;
  input.setAttribute("aria-describedby", "onboarding-error");
  field.append(label, input);
  return field;
}

interface LlmSelectionDraft {
  provider: OnboardingLlmProviderConfiguration;
  modelChoice: string;
  customModel: string;
  endpointMode: OnboardingLlmEndpointSelection["mode"];
  customEndpoint: string;
}

function initialLlmDraft(
  configuration: OnboardingLlmConfiguration,
  statuses: readonly CredentialSlotStatus[],
  chatGptStatus: ChatGptStatus,
): LlmSelectionDraft | undefined {
  const activeCredential = statuses.find(
    (status) => status.slot !== "intervals-icu" && status.runtimeState === "active",
  );
  const preferredProvider =
    configuration.active?.provider ??
    activeCredential?.slot ??
    (chatGptStatus.state === "configured" && chatGptStatus.runtimeReady
      ? "openai-codex"
      : undefined);
  const provider =
    configuration.providers.find((entry) => entry.provider === preferredProvider) ??
    configuration.providers[0];
  if (provider === undefined) return undefined;
  const active = configuration.active;
  const activeModel = active?.provider === provider.provider ? active.model : provider.defaultModel;
  const knownModel = provider.models.some((model) => model.value === activeModel);
  return {
    provider,
    modelChoice: knownModel ? activeModel : CUSTOM_MODEL_SELECTION,
    customModel: knownModel ? "" : activeModel,
    endpointMode: "automatic",
    customEndpoint: "",
  };
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function validCustomEndpoint(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > 4_096 ||
    value.trim() !== value ||
    hasControlCharacters(value)
  ) {
    return false;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.href.includes("?") ||
    url.href.includes("#") ||
    (url.protocol !== "https:" && url.protocol !== "http:")
  ) {
    return false;
  }
  if (url.protocol === "https:") return true;
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "[::1]") {
    return true;
  }
  const octets = hostname.split(".");
  return (
    octets.length === 4 &&
    octets.every((octet) => /^(?:0|[1-9]\d{0,2})$/u.test(octet)) &&
    Number(octets[0]) === 127 &&
    octets.every((octet) => Number(octet) <= 255)
  );
}

function llmSelectionFromDraft(
  draft: LlmSelectionDraft | undefined,
):
  | { readonly selection: OnboardingLlmSelection; readonly error: null }
  | { readonly selection: null; readonly error: OnboardingErrorCode } {
  if (draft === undefined) return { selection: null, error: "configuration-unavailable" };
  const model =
    draft.modelChoice === CUSTOM_MODEL_SELECTION ? draft.customModel.trim() : draft.modelChoice;
  if (
    model.length === 0 ||
    model.length > 512 ||
    model.trim() !== model ||
    hasControlCharacters(model)
  ) {
    return { selection: null, error: "model-selection-required" };
  }
  if (draft.provider.defaultBaseUrl === undefined && draft.endpointMode !== "automatic") {
    return { selection: null, error: "endpoint-invalid" };
  }
  let endpoint: OnboardingLlmEndpointSelection;
  if (draft.endpointMode === "custom") {
    const value = draft.customEndpoint.trim();
    if (!validCustomEndpoint(value)) return { selection: null, error: "endpoint-invalid" };
    endpoint = { mode: "custom", value };
  } else {
    endpoint = { mode: draft.endpointMode };
  }
  return {
    selection: {
      provider: draft.provider.provider,
      model,
      endpoint,
    },
    error: null,
  };
}

export function mountOnboarding(options: MountOnboardingOptions): OnboardingController {
  const rideImports = options.rideImports ?? createRideImportController(options.bridge);
  let state = createOnboardingState();
  let rideImportState: RideImportState = rideImports.state();
  let credentialStatuses: readonly CredentialSlotStatus[] = [];
  let scrim: HTMLElement | undefined;
  let completed = false;
  let disposed = false;
  let opening = false;
  let visit = 0;
  let presentingRideImports = false;
  let llmConfiguration: OnboardingLlmConfiguration | undefined;
  let llmDraft: LlmSelectionDraft | undefined;
  let llmDrafts: Record<string, LlmSelectionDraft> = {};

  const setLlmDraft = (next: LlmSelectionDraft | undefined): void => {
    llmDraft = next;
    if (next !== undefined) llmDrafts[next.provider.provider] = next;
  };

  const setRideImportPresentation = (presenting: boolean): void => {
    if (presentingRideImports === presenting) return;
    presentingRideImports = presenting;
    options.onRideImportPresentationChange?.(presenting);
  };

  const status = (slot: DesktopCredentialSlot): CredentialSlotStatus =>
    credentialStatuses.find((entry) => entry.slot === slot) ?? {
      slot,
      state: state.credentialStatus[slot],
      runtimeState: null,
    };

  const setFixedError = (fixedError: OnboardingErrorCode | null): void => {
    state = { ...state, fixedError };
    const error = scrim?.querySelector<HTMLElement>("#onboarding-error");
    if (error !== null && error !== undefined) {
      error.textContent = fixedError === null ? "" : ERROR_COPY[fixedError];
    }
  };

  const selectedProviderIsReady = (): boolean => {
    const provider = llmDraft?.provider.provider;
    if (provider === undefined) return false;
    if (llmConfiguration?.active?.provider === provider) return true;
    if (provider === "openai-codex") {
      return state.chatGptState === "configured" && state.chatGptRuntimeReady;
    }
    return status(provider).state === "configured" && status(provider).runtimeState === "active";
  };

  const clearPasswordInputs = (): void => {
    for (const input of scrim?.querySelectorAll<HTMLInputElement>('input[type="password"]') ?? []) {
      input.value = "";
    }
  };

  const focusCurrentTitle = (): void => {
    scrim?.querySelector<HTMLElement>("#onboarding-title")?.focus();
  };

  const close = (): void => {
    visit += 1;
    clearPasswordInputs();
    scrim?.remove();
    scrim = undefined;
    setRideImportPresentation(false);
    options.opener.focus();
  };

  const refreshStatuses = async (expectedVisit: number): Promise<boolean> => {
    const [statuses, chatGpt] = await Promise.allSettled([
      options.bridge.credentialStatuses(),
      options.bridge.chatGptStatus(),
    ]);
    if (visit !== expectedVisit || scrim === undefined) return false;
    if (statuses.status === "fulfilled") {
      credentialStatuses = statuses.value;
      state = withCredentialStatuses(state, statuses.value);
    }
    if (chatGpt.status === "fulfilled") {
      state = withChatGptStatus(state, chatGpt.value);
    } else if (
      statuses.status === "fulfilled" &&
      statuses.value.some(
        (status) => status.slot !== "intervals-icu" && status.runtimeState === "active",
      )
    ) {
      state = { ...state, chatGptRuntimeReady: false };
    }
    return statuses.status === "fulfilled";
  };

  const savePasswordControls = async (
    root: HTMLElement,
    expectedVisit: number,
    selection?: OnboardingLlmSelection,
  ): Promise<{
    readonly error: OnboardingErrorCode | null;
    readonly selectedApplied: boolean;
  } | null> => {
    const controls = Array.from(
      root.querySelectorAll<HTMLInputElement>('input[type="password"][data-slot]'),
      (input): TransientPasswordInput => {
        input.disabled = true;
        const control = { value: input.value, dataset: { slot: input.dataset.slot } };
        input.value = "";
        return control;
      },
    );
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
      if (visit !== expectedVisit || scrim === undefined) return null;
      try {
        if (input.value.trim().length === 0) continue;
        attempted = true;
        let configured = false;
        const appliesSelection = input.dataset.slot === selectedSlot;
        await handoffCredential(
          input,
          async (value) => {
            const result = await options.bridge.writeCredential(value);
            if (disposed || visit !== expectedVisit || scrim === undefined) return;
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
        if (disposed || visit !== expectedVisit || scrim === undefined) return null;
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
      if (disposed || visit !== expectedVisit || scrim === undefined) return null;
    }
    if (attempted) {
      if (!(await refreshStatuses(expectedVisit))) {
        statusRefreshFailed = true;
      }
      if (disposed || visit !== expectedVisit || scrim === undefined) return null;
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
        (status) =>
          status === undefined || status.state === "missing" || status.state === "re-prompt",
      )
    ) {
      return { error: "credential-reenter-required", selectedApplied };
    }
    if (refreshedRuntimeStatuses.some((status) => status?.runtimeState === "failed")) {
      return { error: "runtime-unavailable", selectedApplied };
    }
    return { error: null, selectedApplied };
  };

  const importStatusCopy = (): string => {
    return rideImportStatusCopy(rideImportState);
  };

  const updateImportPresentation = (): void => {
    if (scrim === undefined) return;
    const importBusy = state.step === "training-data" && rideImports.isBusy();
    for (const button of scrim.querySelectorAll<HTMLButtonElement>("button")) {
      if (!button.classList.contains("onboarding-dismiss")) {
        button.disabled = state.busy || importBusy;
      }
    }
    const live = scrim.querySelector<HTMLElement>(".import-status");
    if (live !== null) {
      const copy = importStatusCopy();
      live.textContent = copy;
      live.hidden = copy.length === 0;
      live.dataset.state = rideImportState.status;
    }
    const error = scrim.querySelector<HTMLElement>("#onboarding-error");
    if (error !== null) {
      error.textContent = state.fixedError === null ? "" : ERROR_COPY[state.fixedError];
    }
  };

  const updateIntakeFromControl = (
    key: "priorBsi" | "injuryStatus" | "clinicianCleared",
    value: boolean | "none" | "managing" | "returning",
  ): void => {
    state = withIntake(state, { [key]: value });
    render();
    const name = {
      priorBsi: "prior-bsi",
      injuryStatus: "injury-status",
      clinicianCleared: "clinician-cleared",
    }[key];
    scrim?.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`)?.focus();
  };

  const radio = (
    document: Document,
    name: string,
    labelText: string,
    checked: boolean,
    onChange: () => void,
  ): HTMLLabelElement => {
    const label = make(document, "label", "radio-option");
    const input = make(document, "input");
    input.type = "radio";
    input.name = name;
    input.checked = checked;
    input.setAttribute("aria-describedby", "onboarding-error");
    input.addEventListener("change", onChange);
    label.append(input, document.createTextNode(labelText));
    return label;
  };

  const renderLlmSelectionPanel = (panel: HTMLElement): void => {
    panel.replaceChildren();
    if (llmConfiguration === undefined || llmDraft === undefined) {
      panel.append(
        make(
          options.document,
          "p",
          "llm-configuration-unavailable",
          ERROR_COPY["configuration-unavailable"],
        ),
      );
      return;
    }

    const providerField = make(options.document, "label", "llm-selection-field");
    providerField.htmlFor = "onboarding-llm-provider";
    providerField.append(
      make(options.document, "span", "llm-selection-label", "Active coach provider"),
    );
    const providerSelect = make(options.document, "select");
    providerSelect.id = "onboarding-llm-provider";
    providerSelect.disabled = state.busy;
    for (const provider of llmConfiguration.providers) {
      const option = make(options.document, "option");
      option.value = provider.provider;
      option.textContent = ONBOARDING_LLM_PROVIDER_LABELS[provider.provider];
      providerSelect.append(option);
    }
    providerSelect.value = llmDraft.provider.provider;
    providerSelect.addEventListener("change", () => {
      const provider = llmConfiguration?.providers.find(
        (entry) => entry.provider === providerSelect.value,
      );
      if (provider === undefined) return;
      setLlmDraft(
        llmDrafts[provider.provider] ?? {
          provider,
          modelChoice: provider.defaultModel,
          customModel: "",
          endpointMode: "automatic",
          customEndpoint: "",
        },
      );
      setFixedError(null);
      renderLlmSelectionPanel(panel);
      panel.querySelector<HTMLSelectElement>("#onboarding-llm-provider")?.focus();
    });
    providerField.append(providerSelect);

    const modelField = make(options.document, "label", "llm-selection-field");
    modelField.htmlFor = "onboarding-llm-model";
    modelField.append(make(options.document, "span", "llm-selection-label", "Model"));
    const modelSelect = make(options.document, "select");
    modelSelect.id = "onboarding-llm-model";
    modelSelect.disabled = state.busy;
    for (const model of llmDraft.provider.models) {
      const option = make(options.document, "option");
      option.value = model.value;
      option.textContent =
        model.hint === undefined ? model.label : `${model.label} · ${model.hint}`;
      modelSelect.append(option);
    }
    const customOption = make(options.document, "option");
    customOption.value = CUSTOM_MODEL_SELECTION;
    customOption.textContent = "Other model…";
    modelSelect.append(customOption);
    modelSelect.value = llmDraft.modelChoice;
    modelSelect.addEventListener("change", () => {
      if (llmDraft === undefined) return;
      setLlmDraft({
        ...llmDraft,
        modelChoice: modelSelect.value,
        customModel: modelSelect.value === CUSTOM_MODEL_SELECTION ? llmDraft.customModel : "",
      });
      setFixedError(null);
      renderLlmSelectionPanel(panel);
      const target =
        modelSelect.value === CUSTOM_MODEL_SELECTION
          ? panel.querySelector<HTMLInputElement>("#onboarding-custom-model")
          : panel.querySelector<HTMLSelectElement>("#onboarding-llm-model");
      target?.focus();
    });
    modelField.append(modelSelect);

    panel.append(providerField, modelField);

    if (llmDraft.modelChoice === CUSTOM_MODEL_SELECTION) {
      const customModelField = make(options.document, "label", "llm-selection-field");
      customModelField.htmlFor = "onboarding-custom-model";
      customModelField.append(
        make(options.document, "span", "llm-selection-label", "Custom model name"),
      );
      const customModel = make(options.document, "input");
      customModel.id = "onboarding-custom-model";
      customModel.type = "text";
      customModel.autocomplete = "off";
      customModel.maxLength = 512;
      customModel.value = llmDraft.customModel;
      customModel.disabled = state.busy;
      customModel.setAttribute("aria-describedby", "onboarding-error");
      customModel.addEventListener("input", () => {
        if (llmDraft === undefined) return;
        setLlmDraft({ ...llmDraft, customModel: customModel.value });
        setFixedError(null);
      });
      customModelField.append(customModel);
      panel.append(customModelField);
    }

    if (llmDraft.provider.defaultBaseUrl !== undefined) {
      const endpointField = make(options.document, "label", "llm-selection-field");
      endpointField.htmlFor = "onboarding-endpoint-mode";
      endpointField.append(make(options.document, "span", "llm-selection-label", "Endpoint"));
      const endpointMode = make(options.document, "select");
      endpointMode.id = "onboarding-endpoint-mode";
      endpointMode.disabled = state.busy;
      for (const [value, copy] of [
        ["automatic", "Keep current, or use provider default"],
        ["default", "Reset to provider default"],
        ["custom", "Use a custom endpoint"],
      ] as const) {
        const option = make(options.document, "option");
        option.value = value;
        option.textContent = copy;
        endpointMode.append(option);
      }
      endpointMode.value = llmDraft.endpointMode;
      endpointMode.addEventListener("change", () => {
        if (
          llmDraft === undefined ||
          !["automatic", "default", "custom"].includes(endpointMode.value)
        ) {
          return;
        }
        setLlmDraft({
          ...llmDraft,
          endpointMode: endpointMode.value as OnboardingLlmEndpointSelection["mode"],
        });
        setFixedError(null);
        renderLlmSelectionPanel(panel);
        const target =
          endpointMode.value === "custom"
            ? panel.querySelector<HTMLInputElement>("#onboarding-custom-endpoint")
            : panel.querySelector<HTMLSelectElement>("#onboarding-endpoint-mode");
        target?.focus();
      });
      endpointField.append(endpointMode);
      panel.append(endpointField);

      const endpointHelp = make(options.document, "p", "llm-endpoint-help");
      endpointHelp.textContent = `Provider default: ${llmDraft.provider.defaultBaseUrl}`;
      panel.append(endpointHelp);

      if (llmDraft.endpointMode === "custom") {
        const customEndpointField = make(options.document, "label", "llm-selection-field");
        customEndpointField.htmlFor = "onboarding-custom-endpoint";
        customEndpointField.append(
          make(options.document, "span", "llm-selection-label", "Custom endpoint"),
        );
        const customEndpoint = make(options.document, "input");
        customEndpoint.id = "onboarding-custom-endpoint";
        customEndpoint.type = "url";
        customEndpoint.autocomplete = "off";
        customEndpoint.maxLength = 4_096;
        customEndpoint.value = llmDraft.customEndpoint;
        customEndpoint.disabled = state.busy;
        customEndpoint.setAttribute("aria-describedby", "onboarding-error");
        customEndpoint.addEventListener("input", () => {
          if (llmDraft === undefined) return;
          setLlmDraft({ ...llmDraft, customEndpoint: customEndpoint.value });
          setFixedError(null);
        });
        customEndpointField.append(customEndpoint);
        panel.append(customEndpointField);
      }
    }
  };

  const renderLlmSelection = (body: HTMLElement): void => {
    const section = make(options.document, "section", "llm-selection");
    section.setAttribute("aria-labelledby", "llm-selection-heading");
    const heading = make(options.document, "h2", undefined, "Choose provider and model");
    heading.id = "llm-selection-heading";
    section.append(
      heading,
      make(
        options.document,
        "p",
        "llm-selection-copy",
        "Your selected provider becomes active when you continue. Other saved keys stay available but inactive.",
      ),
    );
    const panel = make(options.document, "div", "llm-selection-panel");
    renderLlmSelectionPanel(panel);
    section.append(panel);
    body.append(section);
  };

  const startChatGptLogin = (): void => {
    if (disposed || scrim === undefined || state.busy || state.chatGptState === "pending") {
      return;
    }
    if (llmDraft?.provider.provider !== "openai-codex") {
      const chatGpt = llmConfiguration?.providers.find(
        (provider) => provider.provider === "openai-codex",
      );
      if (chatGpt === undefined) {
        setFixedError("configuration-unavailable");
        return;
      }
      setLlmDraft(
        llmDrafts[chatGpt.provider] ?? {
          provider: chatGpt,
          modelChoice: chatGpt.defaultModel,
          customModel: "",
          endpointMode: "automatic",
          customEndpoint: "",
        },
      );
    }
    const parsedSelection = llmSelectionFromDraft(llmDraft);
    if (parsedSelection.error !== null) {
      setFixedError(parsedSelection.error);
      return;
    }
    const loginVisit = visit;
    state = withChatGptPending(state);
    render();
    void options.bridge.chatGptLogin(parsedSelection.selection).then(
      async (result) => {
        if (
          disposed ||
          visit !== loginVisit ||
          scrim === undefined ||
          state.chatGptState !== "pending"
        ) {
          return;
        }
        state = withChatGptLoginResult(state, result);
        if (result.status === "configured") {
          await refreshStatuses(loginVisit).catch(() => undefined);
        }
        if (disposed || visit !== loginVisit || scrim === undefined) return;
        render();
        focusCurrentTitle();
      },
      () => {
        if (
          disposed ||
          visit !== loginVisit ||
          scrim === undefined ||
          state.chatGptState !== "pending"
        ) {
          return;
        }
        state = withChatGptLoginResult(state, {
          status: "refused",
          reason: "exchange-failed",
        });
        render();
        focusCurrentTitle();
      },
    );
  };

  const chatGptLoginButton = (text: string): HTMLButtonElement => {
    const button = make(options.document, "button", "primary-button chatgpt-signin-button", text);
    button.type = "button";
    button.disabled = state.busy;
    button.addEventListener("click", startChatGptLogin);
    return button;
  };

  const currentStepOwnsCredentialSlot = (slot: DesktopCredentialSlot): boolean => {
    if (state.step === "coach-keys") return false;
    return state.step === "training-data" && slot === "intervals-icu";
  };

  const currentStepHasRetryableCredential = (): boolean =>
    credentialStatuses.some(
      (entry) =>
        currentStepOwnsCredentialSlot(entry.slot) && credentialPresentation(entry).retryable,
    );

  const renderCredentialRetry = (body: HTMLElement): void => {
    if (!currentStepHasRetryableCredential()) return;

    const retry = make(options.document, "button", "text-button", "Retry saved keys");
    retry.type = "button";
    retry.disabled = state.busy;
    retry.addEventListener("click", () => {
      if (disposed || scrim === undefined || state.busy) return;
      const retryVisit = visit;
      const retryStep = state.step;
      state = withBusy(state, true);
      render();
      focusCurrentTitle();
      void (async () => {
        try {
          const statuses = await options.bridge.retryFailedCredentials();
          if (visit !== retryVisit || scrim === undefined) return;
          let nextState = withCredentialStatuses(state, statuses);
          if (retryStep === "coach-keys") {
            try {
              nextState = withChatGptStatus(nextState, await options.bridge.chatGptStatus());
            } catch {
              nextState = { ...nextState, chatGptRuntimeReady: false };
            }
          }
          if (visit !== retryVisit || scrim === undefined) return;
          credentialStatuses = statuses;
          state = withBusy(nextState, false);
          render();
          focusCurrentTitle();
        } catch {
          if (visit !== retryVisit || scrim === undefined) return;
          state = withError(state, "runtime-unavailable");
          render();
          focusCurrentTitle();
        }
      })();
    });
    body.append(retry);
  };

  const renderCoachKeys = (body: HTMLElement): void => {
    body.append(
      make(options.document, "p", "onboarding-kicker", "Coach keys"),
      make(options.document, "h1", undefined, "Choose how your coach thinks"),
      make(
        options.document,
        "p",
        "onboarding-copy",
        "ChatGPT sign-in is saved in a local profile file. API keys are encrypted by macOS. The local coaching service uses your choice to contact the provider.",
      ),
    );
    renderLlmSelection(body);
    const chatGptLane = make(options.document, "section", "chatgpt-lane");
    const chatGptHeading = make(options.document, "div", "chatgpt-lane-heading");
    const chatGptActive = state.chatGptState === "configured" && state.chatGptRuntimeReady;
    const chatGptStored = state.chatGptState === "configured" && !state.chatGptRuntimeReady;
    chatGptHeading.append(
      make(options.document, "strong", undefined, "ChatGPT subscription"),
      make(
        options.document,
        "span",
        `credential-state ${chatGptActive ? "configured" : chatGptStored ? "stored-inactive" : ""}`,
        chatGptActive ? "Configured" : chatGptStored ? "Saved · Not in use" : "No API key",
      ),
    );
    chatGptLane.append(
      chatGptHeading,
      make(options.document, "p", undefined, "Requires a paid ChatGPT plan. No API key needed."),
    );
    if (state.chatGptState === "pending") {
      const pending = make(
        options.document,
        "button",
        "primary-button chatgpt-signin-button",
        "Finish signing in in your browser…",
      );
      pending.type = "button";
      pending.disabled = true;
      chatGptLane.append(pending);
    } else if (state.chatGptState === "configured" && state.chatGptRuntimeReady) {
      chatGptLane.append(
        make(options.document, "p", "chatgpt-login-state configured", "ChatGPT is ready."),
        chatGptLoginButton("Sign in again"),
      );
    } else {
      if (state.chatGptState === "refused" && state.chatGptRefusal !== null) {
        const refusal = make(
          options.document,
          "p",
          "chatgpt-login-state refused",
          CHATGPT_REFUSAL_COPY[state.chatGptRefusal],
        );
        refusal.setAttribute("aria-live", "polite");
        chatGptLane.append(refusal);
      }
      if (state.chatGptState === "configured") {
        chatGptLane.append(
          make(
            options.document,
            "p",
            "chatgpt-login-state",
            "Your ChatGPT sign-in is saved. Sign in again to activate it.",
          ),
        );
      }
      const login = chatGptLoginButton(
        state.chatGptState === "absent" ? "Sign in with ChatGPT" : "Retry ChatGPT sign-in",
      );
      chatGptLane.append(login);
    }
    body.append(chatGptLane);
    body.append(make(options.document, "div", "source-divider", "or use an API key"));
    const primary = make(options.document, "div", "credential-list");
    for (const provider of PRIMARY_MODEL_CREDENTIAL_SLOTS) {
      const control = passwordControl(
        options.document,
        provider.id,
        provider.label,
        status(provider.id),
        state.busy,
      );
      control
        .querySelector("label")
        ?.append(make(options.document, "span", "provider-hint", provider.hint));
      primary.append(control);
    }
    body.append(primary);
    const advanced = make(options.document, "details", "advanced-credentials");
    advanced.append(make(options.document, "summary", undefined, "Advanced providers"));
    const advancedList = make(options.document, "div", "credential-list");
    for (const provider of ADVANCED_MODEL_CREDENTIAL_SLOTS) {
      advancedList.append(
        passwordControl(
          options.document,
          provider.id,
          provider.label,
          status(provider.id),
          state.busy,
        ),
      );
    }
    advanced.append(advancedList);
    body.append(advanced);
    renderCredentialRetry(body);
  };

  const renderTrainingData = (body: HTMLElement): void => {
    body.append(
      make(options.document, "p", "onboarding-kicker", "Training data"),
      make(options.document, "h1", undefined, "Bring your riding history"),
    );
    const guidance = make(options.document, "p", "onboarding-copy");
    guidance.append(
      options.document.createTextNode("Connect your device platform to intervals.icu "),
      make(options.document, "strong", undefined, "directly"),
      options.document.createTextNode(", not via Strava."),
    );
    guidance.setAttribute("aria-label", INTERVALS_GUIDANCE);
    body.append(guidance);
    body.append(
      passwordControl(
        options.document,
        "intervals-icu",
        "intervals.icu API key",
        status("intervals-icu"),
        state.busy,
      ),
    );
    renderCredentialRetry(body);
    const divider = make(options.document, "div", "source-divider", "or import ride files");
    body.append(divider);
    const chooser = make(options.document, "button", "drop-zone");
    chooser.type = "button";
    chooser.disabled = state.busy || rideImports.isBusy();
    chooser.append(
      make(options.document, "strong", undefined, "Choose FIT, TCX, or GPX files"),
      make(options.document, "span", undefined, "You can also drop files here."),
    );
    chooser.addEventListener("click", () => {
      void rideImports.chooseAndImport("onboarding");
    });
    body.append(chooser);
  };

  const renderSafetyIntake = (body: HTMLElement): void => {
    body.append(
      make(options.document, "p", "onboarding-kicker", "Safety intake"),
      make(options.document, "h1", undefined, "A few safety checks"),
      make(
        options.document,
        "p",
        "onboarding-copy",
        "These answers record context for your coach. They are not a diagnosis.",
      ),
    );
    const bsi = make(options.document, "fieldset");
    bsi.append(make(options.document, "legend", undefined, "Have you had a bone stress injury?"));
    bsi.append(
      radio(options.document, "prior-bsi", "Yes", state.intake.priorBsi === true, () =>
        updateIntakeFromControl("priorBsi", true),
      ),
      radio(options.document, "prior-bsi", "No", state.intake.priorBsi === false, () =>
        updateIntakeFromControl("priorBsi", false),
      ),
    );
    const injury = make(options.document, "fieldset");
    injury.append(
      make(options.document, "legend", undefined, "What is your current injury status?"),
    );
    injury.append(
      radio(
        options.document,
        "injury-status",
        "No current injury",
        state.intake.injuryStatus === "none",
        () => updateIntakeFromControl("injuryStatus", "none"),
      ),
      radio(
        options.document,
        "injury-status",
        "Managing an injury",
        state.intake.injuryStatus === "managing",
        () => updateIntakeFromControl("injuryStatus", "managing"),
      ),
      radio(
        options.document,
        "injury-status",
        "Returning after an injury",
        state.intake.injuryStatus === "returning",
        () => updateIntakeFromControl("injuryStatus", "returning"),
      ),
    );
    body.append(bsi, injury);
    if (
      state.intake.priorBsi === true ||
      (state.intake.injuryStatus !== null && state.intake.injuryStatus !== "none")
    ) {
      const clearance = make(options.document, "fieldset");
      clearance.append(
        make(
          options.document,
          "legend",
          undefined,
          "Has a clinician cleared your current return to training?",
        ),
      );
      clearance.append(
        radio(
          options.document,
          "clinician-cleared",
          "Yes",
          state.intake.clinicianCleared === true,
          () => updateIntakeFromControl("clinicianCleared", true),
        ),
        radio(
          options.document,
          "clinician-cleared",
          "No",
          state.intake.clinicianCleared === false,
          () => updateIntakeFromControl("clinicianCleared", false),
        ),
      );
      body.append(clearance);
    }
  };

  const renderReady = (body: HTMLElement): void => {
    body.append(
      make(options.document, "p", "onboarding-kicker", "Ready"),
      make(options.document, "h1", undefined, "Your coach is ready"),
      make(
        options.document,
        "p",
        "onboarding-copy",
        "Start with what you are training for, how the last week felt, or what you want help deciding.",
      ),
    );
    const preview = make(options.document, "div", "ready-preview");
    preview.append(
      make(options.document, "span", undefined, "Keys secured"),
      make(
        options.document,
        "span",
        undefined,
        state.credentialStatus["intervals-icu"] === "configured"
          ? "Training data connected"
          : "Ride files saved to your local library",
      ),
      make(options.document, "span", undefined, "Safety context saved"),
    );
    body.append(preview);
  };

  const submitCurrentStep = async (dialog: HTMLElement): Promise<void> => {
    if (state.busy || (state.step === "training-data" && rideImports.isBusy())) return;
    const submitVisit = visit;
    state = withBusy(state, true);
    for (const button of dialog.querySelectorAll<HTMLButtonElement>("button"))
      button.disabled = true;
    for (const input of dialog.querySelectorAll<HTMLInputElement>("input")) input.disabled = true;
    for (const select of dialog.querySelectorAll<HTMLSelectElement>("select"))
      select.disabled = true;
    const actionStatus = dialog.querySelector<HTMLElement>(".onboarding-action-status");
    if (actionStatus !== null) {
      actionStatus.textContent = "Working…";
      actionStatus.hidden = false;
    }
    if (state.step === "coach-keys") {
      const parsedSelection = llmSelectionFromDraft(llmDraft);
      if (parsedSelection.error !== null) {
        state = withError(state, parsedSelection.error);
        render();
        focusCurrentTitle();
        return;
      }
      const saved = await savePasswordControls(dialog, submitVisit, parsedSelection.selection);
      if (visit !== submitVisit || scrim === undefined) return;
      if (saved === null) return;
      let saveError = saved.error;
      if (saveError === "runtime-unavailable") saveError = "model-runtime-unavailable";
      if (saveError === null && !saved.selectedApplied) {
        try {
          const applied = await options.bridge.applyLlmSelection(parsedSelection.selection);
          if (visit !== submitVisit || scrim === undefined) return;
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
          if (visit !== submitVisit || scrim === undefined) return;
          saveError = "model-runtime-unavailable";
        }
      }
      state = withBusy(state, false);
      if (saveError !== null) state = withError(state, saveError);
      else if (!selectedProviderIsReady()) state = withError(state, "model-runtime-unavailable");
      else state = nextStep(state, true);
      render();
      focusCurrentTitle();
      return;
    }
    if (state.step === "training-data") {
      const saved = await savePasswordControls(dialog, submitVisit);
      if (visit !== submitVisit || scrim === undefined) return;
      if (saved === null) return;
      const saveError = saved.error;
      state = withBusy(state, false);
      if (saveError !== null) state = withError(state, saveError);
      else if (currentStepHasRetryableCredential()) state = withError(state, "runtime-unavailable");
      else if (!hasTrainingData(state)) state = withError(state, "training-data-required");
      else state = nextStep(state);
      render();
      focusCurrentTitle();
      return;
    }
    if (state.step === "safety-intake") {
      let intake: ReturnType<typeof toDesktopIntakeFlags>;
      try {
        intake = toDesktopIntakeFlags(state.intake);
      } catch {
        state = withError(state, "intake-incomplete");
        render();
        focusCurrentTitle();
        return;
      }
      try {
        await options.bridge.saveIntake(intake);
        if (visit !== submitVisit || scrim === undefined) return;
        state = nextStep(withBusy(state, false));
      } catch {
        if (visit !== submitVisit || scrim === undefined) return;
        state = withError(state, "intake-save-failed");
      }
      render();
      focusCurrentTitle();
      return;
    }
    if (!completed) {
      completed = true;
      visit += 1;
      scrim?.remove();
      scrim = undefined;
      setRideImportPresentation(false);
      options.onComplete(toOnboardingCompletion(state));
    }
  };

  const render = (): void => {
    if (scrim === undefined) return;
    clearPasswordInputs();
    scrim.replaceChildren();
    const dialog = make(options.document, "section", "onboarding");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "onboarding-title");
    const header = make(options.document, "header", "onboarding-header");
    const progress = make(options.document, "div", "onboarding-progress");
    const activeIndex = ONBOARDING_STEP_IDS.indexOf(state.step);
    ONBOARDING_STEP_IDS.forEach((step, index) => {
      const indicator = make(options.document, "span", index <= activeIndex ? "active" : undefined);
      if (step === state.step) indicator.setAttribute("aria-current", "step");
      progress.append(indicator);
    });
    progress.setAttribute("aria-label", `Step ${activeIndex + 1} of ${ONBOARDING_STEP_IDS.length}`);
    const dismiss = make(options.document, "button", "onboarding-dismiss", "Dismiss");
    dismiss.type = "button";
    dismiss.addEventListener("click", close);
    header.append(progress, dismiss);
    const body = make(options.document, "div", "onboarding-body");
    if (state.step === "coach-keys") renderCoachKeys(body);
    if (state.step === "training-data") renderTrainingData(body);
    if (state.step === "safety-intake") renderSafetyIntake(body);
    if (state.step === "ready") renderReady(body);
    const title = body.querySelector("h1");
    if (title !== null) {
      title.id = "onboarding-title";
      title.tabIndex = -1;
    }
    const importStatus = make(options.document, "p", "import-status");
    importStatus.setAttribute("role", "status");
    importStatus.setAttribute("aria-live", "polite");
    importStatus.setAttribute("aria-atomic", "true");
    importStatus.textContent = importStatusCopy();
    importStatus.hidden = importStatus.textContent.length === 0;
    importStatus.dataset.state = rideImportState.status;
    body.append(importStatus);
    const error = make(options.document, "p", "onboarding-error");
    error.id = "onboarding-error";
    error.setAttribute("aria-live", "polite");
    if (state.fixedError !== null) error.textContent = ERROR_COPY[state.fixedError];
    body.append(error);
    const actionStatus = make(
      options.document,
      "p",
      "onboarding-action-status",
      state.busy ? "Working…" : "",
    );
    actionStatus.setAttribute("role", "status");
    actionStatus.setAttribute("aria-live", "polite");
    actionStatus.hidden = !state.busy;
    body.append(actionStatus);
    const footer = make(options.document, "footer", "onboarding-footer");
    const importBusy = state.step === "training-data" && rideImports.isBusy();
    if (activeIndex > 0) {
      const back = make(options.document, "button", "secondary-button", "Back");
      back.type = "button";
      back.disabled = state.busy || importBusy;
      back.addEventListener("click", () => {
        state = previousStep(state);
        render();
        focusCurrentTitle();
      });
      footer.append(back);
    } else {
      footer.append(make(options.document, "span"));
    }
    const submit = make(
      options.document,
      "button",
      "primary-button",
      state.step === "ready" ? "Finish setup" : "Continue",
    );
    submit.type = "button";
    submit.disabled = state.busy || importBusy;
    submit.addEventListener("click", () => void submitCurrentStep(dialog));
    footer.append(submit);
    dialog.append(header, body, footer);
    dialog.addEventListener("keydown", (event) => {
      const targetTagName = (event.target as HTMLElement | null)?.tagName;
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      if (
        event.key === "Enter" &&
        targetTagName !== "BUTTON" &&
        targetTagName !== "SUMMARY" &&
        targetTagName !== "SELECT"
      ) {
        event.preventDefault();
        void submitCurrentStep(dialog);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = focusableElements(dialog);
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && options.document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && options.document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
    scrim.append(dialog);
  };

  const disposeImportState = rideImports.subscribe((next) => {
    rideImportState = next;
    if (next.status === "succeeded") {
      state = withImportedRideFileCount(state, rideImports.importedFileCount());
    } else if (next.status === "running" && next.owner === "onboarding") {
      state = { ...state, fixedError: null };
    }
    updateImportPresentation();
  });

  return {
    async open(): Promise<void> {
      if (disposed || scrim !== undefined || opening) return;
      opening = true;
      const openVisit = ++visit;
      completed = false;
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
      if (disposed || visit !== openVisit || scrim !== undefined) {
        opening = false;
        return;
      }
      credentialStatuses = statuses;
      state = createOnboardingState(statuses, restoredChatGptStatus);
      if (llmDraft === undefined) state = withError(state, "configuration-unavailable");
      state = withImportedRideFileCount(state, rideImports.importedFileCount());
      scrim = make(options.document, "div", "onboarding-scrim");
      options.document.body.append(scrim);
      setRideImportPresentation(true);
      render();
      focusCurrentTitle();
      opening = false;
    },
    close,
    dispose(): void {
      disposed = true;
      visit += 1;
      clearPasswordInputs();
      scrim?.remove();
      scrim = undefined;
      setRideImportPresentation(false);
      disposeImportState();
    },
    state: () => state,
    ownsDroppedImportFiles: () =>
      !disposed && scrim !== undefined && state.step === "training-data",
    importDroppedFiles(paths) {
      if (
        !disposed &&
        scrim !== undefined &&
        state.step === "training-data" &&
        !state.busy &&
        !rideImports.isBusy()
      ) {
        void rideImports.importPaths("onboarding", paths);
      }
    },
  };
}
