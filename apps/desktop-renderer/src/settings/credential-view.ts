import type { DesktopCredentialId } from "../onboarding/bridge.js";
import type {
  CredentialSettingsEntry,
  CredentialSettingsState,
  CredentialSettingsView,
} from "./credential-controller.js";
import type { ResidentSettingsShell } from "./shell.js";

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

function stateLabel(state: CredentialSettingsEntry["runtimeState"]): string {
  if (state === "active") return "Active";
  if (state === "stored-inactive") return "Saved, not active";
  return "Needs attention";
}

export function createCredentialSettingsView(input: {
  readonly document: Document;
  readonly shell: ResidentSettingsShell;
}): CredentialSettingsView {
  const section = element(
    input.document,
    "fieldset",
    "settings-section credential-settings__section",
  );
  const legend = element(input.document, "legend", "settings-section__legend", "Credentials");
  const intro = element(
    input.document,
    "p",
    "settings-section__intro",
    "Review credentials saved on this Mac. Credential values are never shown.",
  );
  const list = element(input.document, "ul", "credential-settings__list");
  const empty = element(
    input.document,
    "p",
    "credential-settings__empty",
    "No local credentials are stored.",
  );
  const feedback = element(input.document, "p", "credential-settings__feedback");
  feedback.setAttribute("role", "status");
  feedback.setAttribute("aria-live", "polite");
  feedback.setAttribute("aria-atomic", "true");
  const actions = element(input.document, "footer", "credential-settings__actions");
  const retry = element(
    input.document,
    "button",
    "credential-settings__retry",
    "Reconnect & reload",
  );
  retry.type = "button";
  const openSetup = element(input.document, "button", "credential-settings__setup", "Open Setup");
  openSetup.type = "button";
  actions.append(retry, openSetup);
  section.append(legend, intro, list, empty, feedback, actions);
  input.shell.body.append(section);

  let disposed = false;
  let anyMutation = input.shell.mutationActive;
  let lastState: Exclude<CredentialSettingsState, { readonly status: "closed" }> | undefined;
  let handlers:
    | {
        readonly onRetry: () => void;
        readonly onRequestDelete: (credential: DesktopCredentialId) => void;
        readonly onCancelDelete: () => void;
        readonly onConfirmDelete: () => void;
        readonly onOpenSetup: () => void;
      }
    | undefined;
  const deleteButtons = new Map<DesktopCredentialId, HTMLButtonElement>();
  let confirmationCancel: HTMLButtonElement | undefined;
  let confirmationDelete: HTMLButtonElement | undefined;

  const applyInteractivity = (): void => {
    const deleting = lastState?.status === "deleting";
    for (const button of deleteButtons.values()) button.disabled = anyMutation;
    retry.disabled = anyMutation || lastState?.status === "loading";
    openSetup.disabled = anyMutation;
    if (confirmationCancel !== undefined) confirmationCancel.disabled = anyMutation;
    if (confirmationDelete !== undefined) {
      if (deleting) {
        confirmationDelete.disabled = false;
        confirmationDelete.setAttribute("aria-disabled", "true");
      } else {
        confirmationDelete.disabled = anyMutation;
        confirmationDelete.removeAttribute("aria-disabled");
      }
    }
  };

  const renderEntries = (
    entries: readonly CredentialSettingsEntry[],
    confirmation: DesktopCredentialId | null,
  ): void => {
    deleteButtons.clear();
    confirmationCancel = undefined;
    confirmationDelete = undefined;
    const rows = entries.map((entry) => {
      const row = element(input.document, "li", "credential-settings__item");
      row.dataset.credential = entry.credential;
      const identity = element(input.document, "div", "credential-settings__identity");
      const provider = element(
        input.document,
        "span",
        "credential-settings__provider",
        entry.provider,
      );
      const kind = element(input.document, "span", "credential-settings__kind", entry.kind);
      identity.append(provider, kind);
      const runtime = element(
        input.document,
        "span",
        "credential-settings__runtime",
        stateLabel(entry.runtimeState),
      );
      runtime.dataset.state = entry.runtimeState;
      if (confirmation === entry.credential) {
        const confirm = element(input.document, "div", "credential-settings__confirmation");
        confirm.setAttribute("role", "group");
        const title = element(
          input.document,
          "p",
          "credential-settings__confirmation-title",
          `Delete the ${entry.provider} credential?`,
        );
        title.id = `credential-settings-confirm-${entry.credential}`;
        confirm.setAttribute("aria-labelledby", title.id);
        const copy = element(
          input.document,
          "p",
          "credential-settings__confirmation-copy",
          "This removes it from this Mac only. Enduragent will stop using it if it is active. Your provider account is unchanged.",
        );
        const controls = element(
          input.document,
          "div",
          "credential-settings__confirmation-actions",
        );
        confirmationCancel = element(
          input.document,
          "button",
          "credential-settings__cancel-delete",
          "Cancel",
        );
        confirmationCancel.type = "button";
        confirmationDelete = element(
          input.document,
          "button",
          "credential-settings__confirm-delete",
          "Delete credential",
        );
        confirmationDelete.type = "button";
        confirmationDelete.setAttribute(
          "aria-label",
          `Confirm deletion of the ${entry.provider} credential`,
        );
        confirmationCancel.addEventListener("click", () => handlers?.onCancelDelete());
        confirmationDelete.addEventListener("click", () => {
          if (confirmationDelete?.getAttribute("aria-disabled") !== "true") {
            handlers?.onConfirmDelete();
          }
        });
        controls.append(confirmationCancel, confirmationDelete);
        confirm.append(title, copy, controls);
        row.append(identity, runtime, confirm);
      } else {
        const remove = element(input.document, "button", "credential-settings__delete", "Delete");
        remove.type = "button";
        remove.setAttribute("aria-label", `Delete the ${entry.provider} credential`);
        remove.addEventListener("click", () => handlers?.onRequestDelete(entry.credential));
        deleteButtons.set(entry.credential, remove);
        row.append(identity, runtime, remove);
      }
      return row;
    });
    list.replaceChildren(...rows);
  };

  const focus = (): void => {
    const target = lastState !== undefined && "focus" in lastState ? lastState.focus : null;
    if (target === null || target === undefined) return;
    if (target.target === "confirmation-cancel") confirmationCancel?.focus();
    else if (target.target === "confirmation-delete") confirmationDelete?.focus();
    else if (target.target === "setup") openSetup.focus();
    else if (target.target === "delete") deleteButtons.get(target.credential)?.focus();
  };

  const onRetry = (): void => {
    if (!retry.disabled && !disposed) handlers?.onRetry();
  };
  const onOpenSetup = (): void => {
    if (!openSetup.disabled && !disposed) handlers?.onOpenSetup();
  };
  retry.addEventListener("click", onRetry);
  openSetup.addEventListener("click", onOpenSetup);

  const unregisterFocusables = input.shell.registerFocusables(() => [
    ...deleteButtons.values(),
    ...(confirmationCancel === undefined ? [] : [confirmationCancel]),
    ...(confirmationDelete === undefined ? [] : [confirmationDelete]),
    retry,
    openSetup,
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
      const content =
        state.status === "ready" ||
        state.status === "confirming" ||
        state.status === "deleting" ||
        state.status === "deleted" ||
        (state.status === "error" && state.kind === "delete")
          ? state
          : null;
      renderEntries(content?.entries ?? [], content?.confirmation ?? null);
      list.hidden = content === null || content.entries.length === 0;
      empty.hidden = content === null || content.entries.length > 0;
      retry.hidden = !(state.status === "error" && state.kind === "load");
      const recoveryAvailable = "recoveryAvailable" in state && state.recoveryAvailable;
      const announcement = "announcement" in state ? state.announcement : "";
      openSetup.hidden = !recoveryAvailable;
      feedback.hidden = announcement.length === 0;
      feedback.textContent =
        state.status === "loading" ? "Loading saved credentials…" : announcement;
      if (state.status === "loading") feedback.hidden = false;
      applyInteractivity();
      focus();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      handlers = undefined;
      lastState = undefined;
      deleteButtons.clear();
      unsubscribeMutation();
      unregisterFocusables();
      retry.removeEventListener("click", onRetry);
      openSetup.removeEventListener("click", onOpenSetup);
      section.remove();
    },
  };
}
