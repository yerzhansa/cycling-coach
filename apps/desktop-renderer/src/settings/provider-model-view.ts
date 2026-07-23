import { CUSTOM_MODEL_SELECTION, ONBOARDING_LLM_PROVIDER_LABELS } from "../onboarding/constants.js";
import type {
  ProviderModelFormState,
  ProviderModelSettingsState,
  ProviderModelSettingsView,
  ProviderModelValidationError,
} from "./provider-model-controller.js";
import { createResidentSettingsShell, type ResidentSettingsShell } from "./shell.js";

const VALIDATION_COPY: Readonly<Record<ProviderModelValidationError, string>> = {
  "model-required": "Enter a model name.",
  "model-too-long": "Model names must be 512 characters or fewer.",
  "model-control-characters": "Model names can’t contain control characters.",
};

const SAVE_ERROR_COPY = {
  "invalid-input": "That provider or model wasn’t accepted. Check the model name and try again.",
  "credential-required":
    "This provider needs a saved credential before it can coach you. Open Setup to add one.",
  "runtime-unavailable": "Coach settings couldn’t become active. Try saving again.",
  "request-failed": "Coach settings couldn’t be saved right now. Try again.",
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
  state: Exclude<ProviderModelSettingsState, { readonly status: "closed" }>,
): ProviderModelFormState | null {
  if (
    state.status === "ready" ||
    state.status === "saving" ||
    state.status === "saved" ||
    (state.status === "error" && state.kind === "save")
  ) {
    return state;
  }
  return null;
}

function providerLabel(provider: ProviderModelFormState["providers"][number]["provider"]): string {
  return ONBOARDING_LLM_PROVIDER_LABELS[provider];
}

function modelLabel(form: ProviderModelFormState): string {
  const draft = form.draft;
  if (draft === null) return "";
  if (draft.modelChoice === CUSTOM_MODEL_SELECTION) {
    return draft.customModel.trim() || "Choose a model";
  }
  return (
    draft.provider.models.find((model) => model.value === draft.modelChoice)?.label ??
    draft.modelChoice
  );
}

export function createProviderModelSettingsView(input: {
  readonly document: Document;
  readonly shell?: ResidentSettingsShell;
  readonly actionHost?: HTMLElement;
  readonly before?: Node | null;
}): ProviderModelSettingsView {
  if (input.shell === undefined && input.actionHost === undefined) {
    throw new TypeError("Settings view requires a resident shell or action host.");
  }
  const ownsShell = input.shell === undefined;
  const shell =
    input.shell ??
    createResidentSettingsShell({
      document: input.document,
      actionHost: input.actionHost!,
      before: input.before,
    });

  const form = element(input.document, "form", "provider-model-settings__section");
  form.noValidate = true;
  const section = element(input.document, "fieldset", "settings-section");
  const legend = element(input.document, "legend", "settings-section__legend", "Provider & model");
  const intro = element(
    input.document,
    "p",
    "settings-section__intro",
    "Choose which provider and model power your coaching conversations.",
  );

  const current = element(input.document, "p", "provider-model-settings__current");
  const route = element(input.document, "div", "coach-route");
  const routeHeading = element(input.document, "span", "coach-route__heading", "Coach route");
  const routePath = element(input.document, "span", "coach-route__path");
  const routeProvider = element(input.document, "span", "coach-route__provider");
  const routeArrow = element(input.document, "span", "coach-route__arrow", "→");
  routeArrow.setAttribute("aria-hidden", "true");
  const routeModel = element(input.document, "span", "coach-route__model");
  routePath.append(routeProvider, routeArrow, routeModel);
  const routeState = element(input.document, "span", "coach-route__state");
  route.append(routeHeading, routePath, routeState);

  const fields = element(input.document, "div", "provider-model-settings__fields");
  const providerField = element(input.document, "label", "provider-model-settings__field");
  providerField.htmlFor = "provider-model-settings-provider";
  providerField.append(
    element(input.document, "span", "provider-model-settings__label", "Provider"),
  );
  const provider = element(input.document, "select");
  provider.id = "provider-model-settings-provider";
  provider.setAttribute("aria-describedby", "provider-model-settings-current");
  providerField.append(provider);

  const modelField = element(input.document, "label", "provider-model-settings__field");
  modelField.htmlFor = "provider-model-settings-model";
  modelField.append(element(input.document, "span", "provider-model-settings__label", "Model"));
  const model = element(input.document, "select");
  model.id = "provider-model-settings-model";
  modelField.append(model);

  const customField = element(
    input.document,
    "label",
    "provider-model-settings__field provider-model-settings__custom",
  );
  customField.htmlFor = "provider-model-settings-custom-model";
  customField.append(
    element(input.document, "span", "provider-model-settings__label", "Custom model name"),
  );
  const customModel = element(input.document, "input");
  customModel.id = "provider-model-settings-custom-model";
  customModel.type = "text";
  customModel.autocomplete = "off";
  customModel.setAttribute("aria-describedby", "provider-model-settings-validation");
  customField.append(customModel);

  const validation = element(input.document, "p", "provider-model-settings__validation");
  validation.id = "provider-model-settings-validation";
  validation.setAttribute("aria-live", "polite");
  validation.setAttribute("aria-atomic", "true");
  fields.append(providerField, modelField, customField, validation);

  const feedback = element(input.document, "p", "provider-model-settings__feedback");
  feedback.setAttribute("role", "status");
  feedback.setAttribute("aria-live", "polite");
  feedback.setAttribute("aria-atomic", "true");

  const actions = element(input.document, "footer", "provider-model-settings__actions");
  const retry = element(input.document, "button", "provider-model-settings__retry", "Retry");
  retry.type = "button";
  const openSetup = element(
    input.document,
    "button",
    "provider-model-settings__setup",
    "Open Setup",
  );
  openSetup.type = "button";
  const cancel = element(input.document, "button", "provider-model-settings__cancel", "Close");
  cancel.type = "button";
  const save = element(
    input.document,
    "button",
    "provider-model-settings__save",
    "Save coach route",
  );
  save.type = "submit";
  actions.append(retry, openSetup, cancel, save);
  section.append(legend, intro, current, route, fields, feedback, actions);
  form.append(section);
  shell.body.append(form);

  let disposed = false;
  let ownSaving = false;
  let anyMutation = shell.mutationActive;
  let lastState: Exclude<ProviderModelSettingsState, { readonly status: "closed" }> | undefined;
  let handlers:
    | {
        readonly onOpen: () => void;
        readonly onClose: () => void;
        readonly onRetry: () => void;
        readonly onProviderChange: (provider: string) => void;
        readonly onModelChange: (model: string) => void;
        readonly onCustomModelChange: (model: string) => void;
        readonly onSave: () => void;
        readonly onOpenSetup: () => void;
      }
    | undefined;

  const applyInteractivity = (): void => {
    const editable = lastState === undefined ? null : formState(lastState);
    const busy = ownSaving || anyMutation;
    const hasDraft = editable?.draft !== null && editable?.draft !== undefined;
    provider.disabled = busy || editable === null;
    model.disabled = busy || !hasDraft;
    customModel.disabled = busy || !hasDraft;
    retry.disabled = busy;
    openSetup.disabled = busy;
    cancel.disabled = busy;
    const canSave =
      editable !== null &&
      editable.draft !== null &&
      editable.dirty &&
      editable.validationError === null;
    save.disabled = busy || !canSave;
    save.textContent = ownSaving ? "Saving…" : "Save coach route";
  };

  const onCancel = (): void => shell.requestClose();
  const onSubmit = (event: SubmitEvent): void => {
    event.preventDefault();
    if (!save.disabled && !disposed) handlers?.onSave();
  };
  const onProviderChange = (): void => {
    if (!provider.disabled && !disposed) handlers?.onProviderChange(provider.value);
  };
  const onModelChange = (): void => {
    if (model.disabled || disposed) return;
    handlers?.onModelChange(model.value);
    if (model.value === CUSTOM_MODEL_SELECTION) customModel.focus();
  };
  const onCustomModelChange = (): void => {
    if (!customModel.disabled && !disposed) handlers?.onCustomModelChange(customModel.value);
  };
  const onRetry = (): void => {
    if (!retry.disabled && !disposed) handlers?.onRetry();
  };
  const onOpenSetup = (): void => {
    if (!openSetup.disabled && !disposed) handlers?.onOpenSetup();
  };

  cancel.addEventListener("click", onCancel);
  retry.addEventListener("click", onRetry);
  openSetup.addEventListener("click", onOpenSetup);
  provider.addEventListener("change", onProviderChange);
  model.addEventListener("change", onModelChange);
  customModel.addEventListener("input", onCustomModelChange);
  form.addEventListener("submit", onSubmit);

  const unregisterFocusables = shell.registerFocusables(() => [
    provider,
    model,
    customModel,
    retry,
    openSetup,
    cancel,
    save,
  ]);
  const unsubscribeMutation = shell.subscribeToMutation((active) => {
    anyMutation = active;
    applyInteractivity();
  });

  const renderProviderOptions = (state: ProviderModelFormState): void => {
    const options: HTMLOptionElement[] = [];
    if (state.draft === null) {
      const placeholder = element(input.document, "option", undefined, "Choose a provider");
      placeholder.value = "";
      placeholder.disabled = true;
      options.push(placeholder);
    }
    for (const entry of state.providers) {
      const option = element(input.document, "option", undefined, providerLabel(entry.provider));
      option.value = entry.provider;
      options.push(option);
    }
    provider.replaceChildren(...options);
    provider.value = state.draft?.provider.provider ?? "";
  };

  const renderModelOptions = (state: ProviderModelFormState): void => {
    const options: HTMLOptionElement[] = [];
    if (state.draft === null) {
      const placeholder = element(input.document, "option", undefined, "Choose a provider first");
      placeholder.value = "";
      options.push(placeholder);
    } else {
      for (const entry of state.draft.provider.models) {
        const option = element(
          input.document,
          "option",
          undefined,
          entry.hint === undefined ? entry.label : `${entry.label} · ${entry.hint}`,
        );
        option.value = entry.value;
        options.push(option);
      }
      const customOption = element(input.document, "option", undefined, "Other model…");
      customOption.value = CUSTOM_MODEL_SELECTION;
      options.push(customOption);
    }
    model.replaceChildren(...options);
    model.value = state.draft?.modelChoice ?? "";
  };

  if (ownsShell) {
    shell.bind({
      onOpen: () => handlers?.onOpen(),
      onClose: () => handlers?.onClose(),
    });
  }

  return {
    bind(nextHandlers) {
      handlers = nextHandlers;
    },
    open: () => shell.open(),
    close: () => shell.close(),
    render(state) {
      if (disposed) return;
      lastState = state;
      const editable = formState(state);
      ownSaving = state.status === "saving";
      shell.setSectionSaving("provider-model", ownSaving);
      const loading = state.status === "loading";
      const loadError = state.status === "error" && state.kind === "load";

      current.hidden = editable === null;
      route.hidden = editable === null;
      fields.hidden = editable === null;
      retry.hidden = !loadError;
      openSetup.hidden = !(
        state.status === "error" &&
        state.kind === "save" &&
        state.reason === "credential-required"
      );

      if (editable !== null) {
        current.id = "provider-model-settings-current";
        current.textContent =
          editable.active === null
            ? "Active coach settings are unavailable or not configured."
            : `Currently active: ${providerLabel(editable.active.provider)} · ${editable.active.model}`;
        renderProviderOptions(editable);
        renderModelOptions(editable);
        const hasDraft = editable.draft !== null;
        routeProvider.textContent = hasDraft
          ? providerLabel(editable.draft!.provider.provider)
          : "Not configured";
        routeArrow.hidden = !hasDraft;
        routeModel.hidden = !hasDraft;
        routeModel.textContent = modelLabel(editable);
        routeState.textContent = !hasDraft ? "Not active" : editable.dirty ? "Unsaved" : "Active";
        route.dataset.state = !hasDraft ? "empty" : editable.dirty ? "dirty" : "active";
        route.setAttribute(
          "aria-label",
          hasDraft
            ? `Coach route: ${routeProvider.textContent} to ${routeModel.textContent}. ${routeState.textContent}.`
            : "Coach route: not configured.",
        );
        const custom = editable.draft?.modelChoice === CUSTOM_MODEL_SELECTION;
        customField.hidden = !custom;
        const customModelValue = editable.draft?.customModel ?? "";
        if (customModel.value !== customModelValue) customModel.value = customModelValue;
        validation.hidden = editable.validationError === null;
        validation.textContent =
          editable.validationError === null ? "" : VALIDATION_COPY[editable.validationError];
        if (editable.validationError === null) customModel.removeAttribute("aria-invalid");
        else customModel.setAttribute("aria-invalid", "true");
      } else {
        customField.hidden = true;
        validation.hidden = true;
        validation.textContent = "";
        customModel.removeAttribute("aria-invalid");
      }

      feedback.hidden = false;
      if (loading) {
        feedback.textContent = "Loading coach settings…";
      } else if (loadError) {
        feedback.textContent = "Coach settings aren’t available right now. Try again.";
      } else if (state.status === "saving") {
        feedback.textContent = "Saving coach settings…";
      } else if (state.status === "saved") {
        feedback.textContent = "Coach settings saved.";
      } else if (state.status === "error" && state.kind === "save") {
        feedback.textContent = SAVE_ERROR_COPY[state.reason];
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
      shell.setSectionSaving("provider-model", false);
      handlers = undefined;
      lastState = undefined;
      unsubscribeMutation();
      unregisterFocusables();
      cancel.removeEventListener("click", onCancel);
      retry.removeEventListener("click", onRetry);
      openSetup.removeEventListener("click", onOpenSetup);
      provider.removeEventListener("change", onProviderChange);
      model.removeEventListener("change", onModelChange);
      customModel.removeEventListener("input", onCustomModelChange);
      form.removeEventListener("submit", onSubmit);
      form.remove();
      if (ownsShell) shell.dispose();
    },
  };
}
