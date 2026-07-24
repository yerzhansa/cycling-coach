import type {
  AthleteSettingsFormState,
  AthleteSettingsState,
  AthleteSettingsValidationError,
  AthleteSettingsView,
} from "./athlete-controller.js";
import type { ResidentSettingsShell } from "./shell.js";

const VALIDATION_COPY: Readonly<Record<AthleteSettingsValidationError, string>> = {
  "athlete-required": "Enter the athlete ID for the connected training account.",
  "athlete-whitespace": "Athlete IDs cannot begin or end with whitespace.",
  "athlete-too-long": "Athlete IDs must be 512 characters or fewer.",
  "athlete-control-characters": "Athlete IDs can’t contain control characters.",
};

const SAVE_ERROR_COPY = {
  "credential-required": "Connect the training account in Setup before saving its athlete ID.",
  "ownership-unavailable":
    "The connected training account couldn’t be verified. Reconnect and reload before trying again.",
  "training-account-mismatch":
    "That athlete ID does not identify the currently connected training account.",
  "managed-by-environment": "The athlete ID is managed outside Enduragent and wasn’t changed.",
  "request-failed": "The athlete ID couldn’t be saved. Your edit is still here.",
  "not-applied": "The athlete ID wasn’t applied. Reconnect and reload before trying again.",
  "runtime-unavailable":
    "The current training account couldn’t be reloaded. Your edit is still here.",
} as const;

function element<K extends keyof HTMLElementTagNameMap>(
  document: Document,
  name: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const value = document.createElement(name);
  if (className !== undefined) value.className = className;
  if (text !== undefined) value.textContent = text;
  return value;
}

function formState(
  state: Exclude<AthleteSettingsState, { readonly status: "closed" }>,
): AthleteSettingsFormState | null {
  if (
    state.status === "ready" ||
    state.status === "refreshing" ||
    state.status === "saving" ||
    state.status === "saved" ||
    (state.status === "error" && state.kind === "save")
  ) {
    return state;
  }
  return null;
}

export function createAthleteSettingsView(input: {
  readonly document: Document;
  readonly shell: ResidentSettingsShell;
}): AthleteSettingsView {
  const form = element(input.document, "form", "athlete-settings");
  form.noValidate = true;
  const section = element(input.document, "fieldset", "settings-section athlete-settings__section");
  const legend = element(input.document, "legend", "settings-section__legend", "Training account");
  legend.tabIndex = -1;
  const intro = element(
    input.document,
    "p",
    "settings-section__intro",
    "This may only identify the currently connected training account. It cannot switch accounts.",
  );
  const field = element(input.document, "div", "athlete-settings__field");
  const label = element(input.document, "label", "athlete-settings__label", "Athlete ID");
  label.htmlFor = "athlete-settings-id";
  const athleteId = element(input.document, "input");
  athleteId.id = "athlete-settings-id";
  athleteId.type = "text";
  athleteId.autocomplete = "off";
  athleteId.spellcheck = false;
  const help = element(
    input.document,
    "p",
    "athlete-settings__help",
    "Use the exact identifier associated with the credential already connected in Setup.",
  );
  help.id = "athlete-settings-help";
  const managed = element(
    input.document,
    "p",
    "athlete-settings__managed",
    "Managed by an environment variable. Change it outside Enduragent.",
  );
  managed.id = "athlete-settings-managed";
  managed.hidden = true;
  const credential = element(
    input.document,
    "p",
    "athlete-settings__credential",
    "No training account credential is connected. Open Setup to connect one.",
  );
  credential.id = "athlete-settings-credential";
  credential.hidden = true;
  const validation = element(input.document, "p", "athlete-settings__validation");
  validation.id = "athlete-settings-validation";
  validation.setAttribute("aria-live", "polite");
  validation.setAttribute("aria-atomic", "true");
  validation.hidden = true;
  athleteId.setAttribute("aria-describedby", help.id);
  field.append(label, athleteId, help, managed, credential, validation);

  const feedback = element(input.document, "p", "athlete-settings__feedback");
  feedback.setAttribute("role", "status");
  feedback.setAttribute("aria-live", "polite");
  feedback.setAttribute("aria-atomic", "true");
  feedback.tabIndex = -1;
  const actions = element(input.document, "footer", "athlete-settings__actions");
  const retry = element(input.document, "button", "athlete-settings__retry", "Reconnect & reload");
  retry.type = "button";
  const openSetup = element(input.document, "button", "athlete-settings__setup", "Open Setup");
  openSetup.type = "button";
  const save = element(input.document, "button", "athlete-settings__save", "Save athlete ID");
  save.type = "submit";
  actions.append(retry, openSetup, save);
  section.append(legend, intro, field, feedback, actions);
  form.append(section);
  input.shell.body.append(form);

  let disposed = false;
  let ownSaving = false;
  let anyMutation = input.shell.mutationActive;
  let retryFocusPending = false;
  let lastState: Exclude<AthleteSettingsState, { readonly status: "closed" }> | undefined;
  let handlers:
    | {
        readonly onRetry: () => void;
        readonly onChange: (value: string) => void;
        readonly onSave: () => void;
        readonly onOpenSetup: () => void;
      }
    | undefined;

  const applyInteractivity = (): void => {
    const editable = lastState === undefined ? null : formState(lastState);
    const busy =
      anyMutation ||
      ownSaving ||
      lastState?.status === "refreshing" ||
      lastState?.status === "loading";
    const locked =
      editable === null ||
      !editable.effective.credential_configured ||
      editable.effective.managedByEnvironment.athleteId;
    athleteId.disabled = busy || locked;
    retry.disabled = busy;
    openSetup.disabled = busy;
    save.disabled =
      busy || editable === null || !editable.dirty || editable.validationError !== null || locked;
    save.textContent = ownSaving ? "Saving…" : "Save athlete ID";
  };

  const onInput = (): void => {
    if (!athleteId.disabled && !disposed) handlers?.onChange(athleteId.value);
  };
  const onRetry = (): void => {
    if (!retry.disabled && !disposed) handlers?.onRetry();
  };
  const onOpenSetup = (): void => {
    if (!openSetup.disabled && !disposed) handlers?.onOpenSetup();
  };
  const onSubmit = (event: SubmitEvent): void => {
    event.preventDefault();
    if (!save.disabled && !disposed) handlers?.onSave();
  };
  athleteId.addEventListener("input", onInput);
  retry.addEventListener("click", onRetry);
  openSetup.addEventListener("click", onOpenSetup);
  form.addEventListener("submit", onSubmit);

  const unregisterFocusables = input.shell.registerFocusables(() => [
    athleteId,
    retry,
    openSetup,
    save,
  ]);
  const unsubscribeMutation = input.shell.subscribeToMutation((active) => {
    anyMutation = active;
    applyInteractivity();
  });

  return {
    bind(nextHandlers) {
      handlers = nextHandlers;
    },
    render(state) {
      if (disposed) return;
      lastState = state;
      ownSaving = state.status === "saving";
      input.shell.setSectionSaving("athlete", ownSaving);
      const editable = formState(state);
      const loadError = state.status === "error" && state.kind === "load";
      const retryHadFocus = input.document.activeElement === retry;
      field.hidden = editable === null;
      retry.hidden = !(loadError || (state.status === "error" && state.kind === "save"));
      const credentialRequired =
        editable?.effective.credential_configured === false ||
        (state.status === "error" &&
          state.kind === "save" &&
          state.reason === "credential-required");
      openSetup.hidden = !credentialRequired;

      if (editable !== null) {
        if (athleteId.value !== editable.draft) athleteId.value = editable.draft;
        const externallyManaged = editable.effective.managedByEnvironment.athleteId;
        managed.hidden = !externallyManaged;
        credential.hidden = editable.effective.credential_configured;
        validation.hidden = editable.validationError === null;
        validation.textContent =
          editable.validationError === null ? "" : VALIDATION_COPY[editable.validationError];
        if (editable.validationError === null) athleteId.removeAttribute("aria-invalid");
        else athleteId.setAttribute("aria-invalid", "true");
        const describedBy = [
          help.id,
          ...(externallyManaged ? [managed.id] : []),
          ...(!editable.effective.credential_configured ? [credential.id] : []),
          ...(editable.validationError === null ? [] : [validation.id]),
        ];
        athleteId.setAttribute("aria-describedby", describedBy.join(" "));
      }

      feedback.hidden = false;
      if (state.status === "loading") {
        feedback.textContent = "Loading training account settings…";
      } else if (state.status === "refreshing") {
        feedback.textContent = "Reconnecting and checking the current training account…";
      } else if (loadError) {
        feedback.textContent = "Training account settings aren’t available. Reconnect and reload.";
      } else if (state.status === "saving") {
        feedback.textContent = "Saving athlete ID…";
      } else if (state.status === "saved") {
        feedback.textContent = "Athlete ID saved.";
      } else if (state.status === "error" && state.kind === "save") {
        feedback.textContent = SAVE_ERROR_COPY[state.reason];
      } else {
        feedback.textContent = "";
        feedback.hidden = true;
      }
      applyInteractivity();
      const retryInProgress = state.status === "loading" || state.status === "refreshing";
      if (retry.hidden && retryHadFocus) {
        retryFocusPending = true;
        feedback.focus();
      }
      if (retryFocusPending && !retryInProgress) {
        retryFocusPending = false;
        if (!retry.hidden && !retry.disabled) retry.focus();
        else if (!field.hidden && !athleteId.disabled) athleteId.focus();
        else if (!openSetup.hidden && !openSetup.disabled) openSetup.focus();
        else legend.focus();
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      ownSaving = false;
      input.shell.setSectionSaving("athlete", false);
      handlers = undefined;
      lastState = undefined;
      unsubscribeMutation();
      unregisterFocusables();
      athleteId.removeEventListener("input", onInput);
      retry.removeEventListener("click", onRetry);
      openSetup.removeEventListener("click", onOpenSetup);
      form.removeEventListener("submit", onSubmit);
      form.remove();
    },
  };
}
