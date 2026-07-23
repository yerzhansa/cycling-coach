import { CUSTOM_MODEL_SELECTION, ONBOARDING_LLM_PROVIDER_LABELS } from "../onboarding/constants.js";
import type {
  ProviderModelFormState,
  ProviderModelSettingsState,
  ProviderModelSettingsView,
  ProviderModelValidationError,
} from "./provider-model-controller.js";

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
  readonly actionHost: HTMLElement;
  readonly before?: Node | null;
}): ProviderModelSettingsView {
  const opener = element(input.document, "button", "provider-model-settings-button", "Settings");
  opener.type = "button";
  opener.setAttribute("aria-label", "Coach settings");
  opener.setAttribute("aria-haspopup", "dialog");
  opener.setAttribute("aria-controls", "provider-model-settings-dialog");
  opener.setAttribute("aria-expanded", "false");

  const dialog = element(input.document, "dialog", "provider-model-settings-dialog");
  dialog.id = "provider-model-settings-dialog";
  dialog.setAttribute("aria-labelledby", "provider-model-settings-title");
  dialog.setAttribute("aria-describedby", "provider-model-settings-intro");
  dialog.setAttribute("aria-modal", "true");

  const form = element(input.document, "form", "provider-model-settings");
  const header = element(input.document, "header", "provider-model-settings__header");
  const heading = element(input.document, "div");
  const kicker = element(input.document, "p", "provider-model-settings__kicker", "Coach settings");
  const title = element(input.document, "h2", undefined, "Provider and model");
  title.id = "provider-model-settings-title";
  const intro = element(
    input.document,
    "p",
    "provider-model-settings__intro",
    "Choose which provider and model power your coaching conversations.",
  );
  intro.id = "provider-model-settings-intro";
  heading.append(kicker, title, intro);
  const close = element(input.document, "button", "provider-model-settings__close", "Close");
  close.type = "button";
  close.setAttribute("aria-label", "Close coach settings");
  header.append(heading, close);

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
  const cancel = element(input.document, "button", "provider-model-settings__cancel", "Cancel");
  cancel.type = "button";
  const save = element(input.document, "button", "provider-model-settings__save", "Save changes");
  save.type = "submit";
  actions.append(retry, openSetup, cancel, save);
  form.append(header, current, route, fields, feedback, actions);
  dialog.append(form);

  input.actionHost.insertBefore(opener, input.before ?? null);
  input.document.body.append(dialog);

  let disposed = false;
  let saving = false;
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

  const requestClose = (): void => {
    if (!disposed && !saving) handlers?.onClose();
  };
  const onOpen = (): void => {
    if (!disposed) handlers?.onOpen();
  };
  const onCancel = (event: Event): void => {
    event.preventDefault();
    requestClose();
  };
  const onBackdropClick = (event: MouseEvent): void => {
    if (event.target === dialog) requestClose();
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Tab") return;
    const focusable = [close, provider, model, customModel, retry, openSetup, cancel, save].filter(
      (control) =>
        !control.disabled && !control.hidden && (control !== customModel || !customField.hidden),
    );
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && input.document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && input.document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
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

  opener.addEventListener("click", onOpen);
  close.addEventListener("click", requestClose);
  cancel.addEventListener("click", requestClose);
  retry.addEventListener("click", onRetry);
  openSetup.addEventListener("click", onOpenSetup);
  provider.addEventListener("change", onProviderChange);
  model.addEventListener("change", onModelChange);
  customModel.addEventListener("input", onCustomModelChange);
  form.addEventListener("submit", onSubmit);
  dialog.addEventListener("cancel", onCancel);
  dialog.addEventListener("click", onBackdropClick);
  dialog.addEventListener("keydown", onKeyDown);

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

  return {
    bind(nextHandlers) {
      handlers = nextHandlers;
    },
    open() {
      if (disposed || dialog.open) return;
      dialog.showModal();
      opener.setAttribute("aria-expanded", "true");
      close.focus();
    },
    close() {
      if (disposed) return;
      if (dialog.open) dialog.close();
      opener.setAttribute("aria-expanded", "false");
      opener.focus();
    },
    render(state) {
      if (disposed) return;
      const editable = formState(state);
      saving = state.status === "saving";
      const loading = state.status === "loading";
      const loadError = state.status === "error" && state.kind === "load";
      opener.disabled = saving;
      close.disabled = saving;
      cancel.disabled = saving;
      provider.disabled = saving || editable?.draft === null;
      model.disabled = saving || editable?.draft === null;
      customModel.disabled = saving;
      retry.disabled = saving;
      openSetup.disabled = saving;
      if (loading || saving) dialog.setAttribute("aria-busy", "true");
      else dialog.removeAttribute("aria-busy");

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
        provider.disabled = saving;
        model.disabled = saving || !hasDraft;
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

      const canSave =
        editable !== null &&
        editable.draft !== null &&
        editable.dirty &&
        editable.validationError === null;
      save.disabled = saving || !canSave;
      save.textContent = saving ? "Saving…" : "Save changes";
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      saving = false;
      handlers = undefined;
      opener.removeEventListener("click", onOpen);
      close.removeEventListener("click", requestClose);
      cancel.removeEventListener("click", requestClose);
      retry.removeEventListener("click", onRetry);
      openSetup.removeEventListener("click", onOpenSetup);
      provider.removeEventListener("change", onProviderChange);
      model.removeEventListener("change", onModelChange);
      customModel.removeEventListener("input", onCustomModelChange);
      form.removeEventListener("submit", onSubmit);
      dialog.removeEventListener("cancel", onCancel);
      dialog.removeEventListener("click", onBackdropClick);
      dialog.removeEventListener("keydown", onKeyDown);
      if (dialog.open) dialog.close();
      opener.remove();
      dialog.remove();
    },
  };
}
