import {
  SESSION_SETTING_FIELDS,
  type SessionSettingField,
  type SessionSettingsFormState,
  type SessionSettingsState,
  type SessionSettingsView,
} from "./session-controller.js";
import type { ResidentSettingsShell } from "./shell.js";

interface FieldDefinition {
  readonly field: SessionSettingField;
  readonly label: string;
  readonly help: string;
  readonly type: "text" | "number";
  readonly min?: string;
  readonly max?: string;
  readonly step?: string;
  readonly suffix?: string;
}

const FIELD_DEFINITIONS: readonly FieldDefinition[] = [
  {
    field: "timezone",
    label: "Timezone",
    help: "Use an IANA timezone, such as Europe/London. This is the current system truth.",
    type: "text",
  },
  {
    field: "dailyResetHour",
    label: "Daily reset hour",
    help: "Athlete-local hour, from 0 to 23. A change may make your next message start a fresh conversation.",
    type: "number",
    min: "0",
    max: "23",
    step: "1",
  },
  {
    field: "idleMinutes",
    label: "Idle reset",
    help: "Whole minutes without a message before the conversation resets. Use 0 to turn this off.",
    type: "number",
    min: "0",
    step: "1",
    suffix: "minutes",
  },
  {
    field: "resetArchiveRetentionDays",
    label: "Archive retention",
    help: "Whole days to keep reset archives. Use 0 to keep them forever; changes apply only to future pruning.",
    type: "number",
    min: "0",
    step: "1",
    suffix: "days",
  },
  {
    field: "historyTokenBudgetRatio",
    label: "History budget",
    help: "Share of the model context reserved for conversation history, above 0% and up to 100%.",
    type: "number",
    min: "0",
    max: "100",
    step: "any",
    suffix: "%",
  },
] as const;

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
  state: Exclude<SessionSettingsState, { readonly status: "closed" }>,
): SessionSettingsFormState | null {
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

export function createSessionSettingsView(input: {
  readonly document: Document;
  readonly shell: ResidentSettingsShell;
}): SessionSettingsView {
  const form = element(input.document, "form", "session-settings");
  form.noValidate = true;
  const section = element(input.document, "fieldset", "settings-section session-settings__section");
  const legend = element(
    input.document,
    "legend",
    "settings-section__legend",
    "Conversation & time",
  );
  const intro = element(
    input.document,
    "p",
    "settings-section__intro",
    "Set when conversations renew and how much recent context your coach carries forward.",
  );
  const fields = element(input.document, "div", "session-settings__fields");

  const controls = new Map<
    SessionSettingField,
    {
      readonly input: HTMLInputElement;
      readonly managed: HTMLElement;
      readonly error: HTMLElement;
      readonly describedBy: readonly string[];
    }
  >();

  for (const definition of FIELD_DEFINITIONS) {
    const field = element(input.document, "div", "session-settings__field");
    const label = element(input.document, "label", "session-settings__label", definition.label);
    const id = `session-settings-${definition.field}`;
    const helpId = `${id}-help`;
    const managedId = `${id}-managed`;
    const errorId = `${id}-error`;
    label.htmlFor = id;
    const value = element(input.document, "div", "session-settings__value");
    const control = element(input.document, "input");
    control.id = id;
    control.type = definition.type;
    control.autocomplete = "off";
    if (definition.type === "number") control.inputMode = "decimal";
    if (definition.min !== undefined) control.min = definition.min;
    if (definition.max !== undefined) control.max = definition.max;
    if (definition.step !== undefined) control.step = definition.step;
    if (definition.field === "timezone") control.spellcheck = false;
    value.append(control);
    if (definition.suffix !== undefined) {
      const suffix = element(input.document, "span", "session-settings__suffix", definition.suffix);
      suffix.setAttribute("aria-hidden", "true");
      value.append(suffix);
    }
    const help = element(input.document, "p", "session-settings__help", definition.help);
    help.id = helpId;
    const managed = element(
      input.document,
      "p",
      "session-settings__managed",
      "Managed by an environment variable. Change it outside Enduragent.",
    );
    managed.id = managedId;
    managed.hidden = true;
    const error = element(input.document, "p", "session-settings__error");
    error.id = errorId;
    error.setAttribute("aria-live", "polite");
    error.setAttribute("aria-atomic", "true");
    error.hidden = true;
    field.append(label, value, help, managed, error);
    fields.append(field);
    controls.set(definition.field, {
      input: control,
      managed,
      error,
      describedBy: [helpId, managedId, errorId],
    });
  }

  const feedback = element(input.document, "p", "session-settings__feedback");
  feedback.setAttribute("role", "status");
  feedback.setAttribute("aria-live", "polite");
  feedback.setAttribute("aria-atomic", "true");
  const actions = element(input.document, "footer", "session-settings__actions");
  const retry = element(input.document, "button", "session-settings__retry", "Reconnect & reload");
  retry.type = "button";
  const save = element(
    input.document,
    "button",
    "session-settings__save",
    "Save conversation settings",
  );
  save.type = "submit";
  actions.append(retry, save);
  section.append(legend, intro, fields, feedback, actions);
  form.append(section);
  input.shell.body.append(form);

  let disposed = false;
  let ownSaving = false;
  let anyMutation = input.shell.mutationActive;
  let lastState: Exclude<SessionSettingsState, { readonly status: "closed" }> | undefined;
  let handlers:
    | {
        readonly onRetry: () => void;
        readonly onChange: (field: SessionSettingField, value: string) => void;
        readonly onSave: () => void;
      }
    | undefined;

  const applyInteractivity = (): void => {
    const editable = lastState === undefined ? null : formState(lastState);
    const busy =
      anyMutation ||
      ownSaving ||
      lastState?.status === "refreshing" ||
      lastState?.status === "loading";
    for (const field of SESSION_SETTING_FIELDS) {
      const control = controls.get(field)!;
      const managed = editable?.effective.managedByEnvironment[field] ?? false;
      control.input.disabled = busy || editable === null || managed;
    }
    retry.disabled = busy;
    const canSave =
      editable !== null &&
      editable.dirtyFields.size > 0 &&
      Object.keys(editable.validationErrors).length === 0;
    save.disabled = busy || !canSave;
    save.textContent = ownSaving ? "Saving…" : "Save conversation settings";
  };

  const onSubmit = (event: SubmitEvent): void => {
    event.preventDefault();
    if (!save.disabled && !disposed) handlers?.onSave();
  };
  const onRetry = (): void => {
    if (!retry.disabled && !disposed) handlers?.onRetry();
  };
  const inputListeners = new Map<SessionSettingField, () => void>();
  for (const field of SESSION_SETTING_FIELDS) {
    const control = controls.get(field)!.input;
    const listener = (): void => {
      if (!control.disabled && !disposed) handlers?.onChange(field, control.value);
    };
    inputListeners.set(field, listener);
    control.addEventListener("input", listener);
  }
  retry.addEventListener("click", onRetry);
  form.addEventListener("submit", onSubmit);

  const unregisterFocusables = input.shell.registerFocusables(() => [
    ...SESSION_SETTING_FIELDS.map((field) => controls.get(field)!.input),
    retry,
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
      input.shell.setSectionSaving("session", ownSaving);
      const editable = formState(state);
      const loadError = state.status === "error" && state.kind === "load";
      fields.hidden = editable === null;
      retry.hidden = !(loadError || (state.status === "error" && state.kind === "save"));

      if (editable !== null) {
        for (const field of SESSION_SETTING_FIELDS) {
          const control = controls.get(field)!;
          const value = editable.draft[field];
          if (control.input.value !== value) control.input.value = value;
          const managed = editable.effective.managedByEnvironment[field];
          const error = editable.validationErrors[field];
          control.managed.hidden = !managed;
          control.error.hidden = error === undefined;
          control.error.textContent = error ?? "";
          if (error === undefined) control.input.removeAttribute("aria-invalid");
          else control.input.setAttribute("aria-invalid", "true");
          const describedBy = control.describedBy.filter(
            (id) =>
              id.endsWith("-help") ||
              (id.endsWith("-managed") && managed) ||
              (id.endsWith("-error") && error !== undefined),
          );
          control.input.setAttribute("aria-describedby", describedBy.join(" "));
        }
      }

      feedback.hidden = false;
      if (state.status === "loading") {
        feedback.textContent = "Loading conversation settings…";
      } else if (state.status === "refreshing") {
        feedback.textContent = "Reconnecting and checking current settings…";
      } else if (loadError) {
        feedback.textContent = "Conversation settings aren’t available. Reconnect and reload.";
      } else if (state.status === "saving") {
        feedback.textContent = "Saving conversation settings…";
      } else if (state.status === "saved") {
        feedback.textContent = "Conversation settings saved.";
      } else if (state.status === "error" && state.kind === "save") {
        feedback.textContent =
          state.reason === "not-applied"
            ? "Conversation settings weren’t applied. Reconnect and reload before trying again."
            : state.reason === "runtime-unavailable"
              ? "Current conversation settings couldn’t be reloaded. Your edits are still here."
              : "Conversation settings couldn’t be saved. Your edits are still here.";
      } else {
        feedback.textContent = "";
        feedback.hidden = true;
      }
      applyInteractivity();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      ownSaving = false;
      input.shell.setSectionSaving("session", false);
      handlers = undefined;
      lastState = undefined;
      unsubscribeMutation();
      unregisterFocusables();
      for (const field of SESSION_SETTING_FIELDS) {
        controls.get(field)!.input.removeEventListener("input", inputListeners.get(field)!);
      }
      retry.removeEventListener("click", onRetry);
      form.removeEventListener("submit", onSubmit);
      form.remove();
    },
  };
}
