import {
  ADVANCED_MODEL_CREDENTIAL_SLOTS,
  INTERVALS_GUIDANCE,
  ONBOARDING_STEP_IDS,
  PRIMARY_MODEL_CREDENTIAL_SLOTS,
  type DesktopCredentialSlot,
  type ModelCredentialSlot,
} from "./constants.js";
import type { OnboardingBridge } from "./bridge.js";
import { credentialPresentation } from "./credential-presentation.js";
import {
  ONBOARDING_COMPLETION,
  createOnboardingState,
  hasConfiguredModel,
  hasTrainingData,
  nextStep,
  previousStep,
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
  readonly opener: HTMLElement;
  readonly onComplete: (completion: OnboardingCompletion) => void;
}

export interface TransientPasswordInput {
  value: string;
  readonly dataset: { readonly slot?: string };
}

export async function handoffCredential(
  input: TransientPasswordInput,
  write: (value: {
    readonly slot: DesktopCredentialSlot;
    readonly value: string;
  }) => Promise<unknown>,
): Promise<boolean> {
  let secret: string | undefined;
  try {
    secret = input.value;
    if (secret.trim().length === 0) return false;
    await write({ slot: input.dataset.slot as DesktopCredentialSlot, value: secret });
    return true;
  } finally {
    input.value = "";
    secret = undefined;
  }
}

const ERROR_COPY: Readonly<Record<OnboardingErrorCode, string>> = {
  "credential-required": "Sign in with ChatGPT or add at least one model key to continue.",
  "credential-save-failed": "That key could not be saved. Try entering it again.",
  "training-account-mismatch":
    "That intervals.icu key belongs to a different athlete than the training history already stored. Switching accounts is not supported yet.",
  "training-data-required": "Connect intervals.icu or import at least one ride file.",
  "intake-incomplete": "Answer the required safety questions to continue.",
  "intake-save-failed": "Your answers could not be saved. Please try again.",
};

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
      'button:not([disabled]), input:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
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
  input.dataset.slot = slot;
  input.setAttribute("aria-describedby", "onboarding-error");
  field.append(label, input);
  return field;
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

  const refreshStatuses = async (expectedVisit: number): Promise<void> => {
    const [statuses, chatGpt] = await Promise.all([
      options.bridge.credentialStatuses(),
      options.bridge.chatGptStatus(),
    ]);
    if (visit !== expectedVisit || scrim === undefined) return;
    credentialStatuses = statuses;
    state = withChatGptStatus(withCredentialStatuses(state, statuses), chatGpt);
  };

  const savePasswordControls = async (
    root: HTMLElement,
    expectedVisit: number,
  ): Promise<OnboardingErrorCode | null> => {
    const controls = Array.from(
      root.querySelectorAll<HTMLInputElement>('input[type="password"][data-slot]'),
    );
    let attempted = false;
    let failure: OnboardingErrorCode | null = null;
    for (const input of controls) {
      if (visit !== expectedVisit || scrim === undefined) return null;
      try {
        if (input.value.trim().length === 0) continue;
        attempted = true;
        let configured = false;
        await handoffCredential(input, async (value) => {
          const result = await options.bridge.writeCredential(value);
          if (result.status === "configured") {
            configured = true;
          } else {
            failure =
              result.reason === "training-account-mismatch"
                ? "training-account-mismatch"
                : (failure ?? "credential-save-failed");
          }
        });
        if (!configured) failure ??= "credential-save-failed";
      } catch {
        failure ??= "credential-save-failed";
      } finally {
        input.value = "";
      }
    }
    if (attempted) {
      try {
        await refreshStatuses(expectedVisit);
      } catch {
        failure ??= "credential-save-failed";
      }
    }
    return failure;
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

  const startChatGptLogin = (): void => {
    if (disposed || scrim === undefined || state.busy || state.chatGptState === "pending") {
      return;
    }
    const loginVisit = visit;
    state = withChatGptPending(state);
    render();
    void options.bridge.chatGptLogin().then(
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
        passwordControl(options.document, provider.id, provider.label, status(provider.id)),
      );
    }
    advanced.append(advancedList);
    body.append(advanced);
    if (credentialStatuses.some((entry) => credentialPresentation(entry).retryable)) {
      const retry = make(options.document, "button", "text-button", "Retry saved keys");
      retry.type = "button";
      retry.disabled = state.busy;
      retry.addEventListener("click", () => {
        const retryVisit = visit;
        state = withBusy(state, true);
        render();
        focusCurrentTitle();
        void options.bridge
          .retryFailedCredentials()
          .then(async () => {
            if (visit !== retryVisit || scrim === undefined) return;
            await refreshStatuses(retryVisit);
            if (visit !== retryVisit || scrim === undefined) return;
            state = withBusy(state, false);
            render();
            focusCurrentTitle();
          })
          .catch(() => {
            if (visit !== retryVisit || scrim === undefined) return;
            state = withError(state, "credential-save-failed");
            render();
            focusCurrentTitle();
          });
      });
      body.append(retry);
    }
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
      ),
    );
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
      make(options.document, "span", undefined, "Training data connected"),
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
    if (state.step === "coach-keys") {
      const saveError = await savePasswordControls(dialog, submitVisit);
      if (visit !== submitVisit || scrim === undefined) return;
      state = withBusy(state, false);
      if (saveError !== null) state = withError(state, saveError);
      else if (!hasConfiguredModel(state)) state = withError(state, "credential-required");
      else state = nextStep(state);
      render();
      focusCurrentTitle();
      return;
    }
    if (state.step === "training-data") {
      const saveError = await savePasswordControls(dialog, submitVisit);
      if (visit !== submitVisit || scrim === undefined) return;
      state = withBusy(state, false);
      if (saveError !== null) state = withError(state, saveError);
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
      options.onComplete(ONBOARDING_COMPLETION);
    }
  };

  const render = (): void => {
    if (scrim === undefined) return;
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
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      if (
        event.key === "Enter" &&
        !(event.target instanceof HTMLButtonElement) &&
        !(event.target instanceof HTMLElement && event.target.tagName === "SUMMARY")
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
      ]);
      if (restored[0].status === "fulfilled") statuses = restored[0].value;
      if (restored[1].status === "fulfilled") restoredChatGptStatus = restored[1].value;
      if (disposed || visit !== openVisit || scrim !== undefined) {
        opening = false;
        return;
      }
      credentialStatuses = statuses;
      state = createOnboardingState(statuses, restoredChatGptStatus);
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
