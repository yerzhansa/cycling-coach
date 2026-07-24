export interface ResidentSettingsShell {
  readonly body: HTMLElement;
  readonly mutationActive: boolean;
  bind(handlers: { readonly onOpen: () => void; readonly onClose: () => void }): void;
  open(): void;
  requestClose(): void;
  close(): void;
  beginMutation(owner: string): (() => void) | null;
  setSectionSaving(owner: string, saving: boolean): void;
  subscribeToMutation(listener: (active: boolean) => void): () => void;
  registerFocusables(values: () => readonly HTMLElement[]): () => void;
  dispose(): void;
}

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

function isFocusable(value: HTMLElement): boolean {
  if (value.hidden) return false;
  const control = value as HTMLElement & { readonly disabled?: boolean };
  if (control.disabled === true) {
    return false;
  }
  for (
    let parent = value.parentElement;
    parent !== null && parent !== undefined;
    parent = parent.parentElement
  ) {
    if (parent.hidden) return false;
  }
  return true;
}

export function createResidentSettingsShell(input: {
  readonly document: Document;
  readonly actionHost: HTMLElement;
  readonly before?: Node | null;
}): ResidentSettingsShell {
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

  const layout = element(input.document, "div", "provider-model-settings");
  const header = element(input.document, "header", "provider-model-settings__header");
  const heading = element(input.document, "div");
  const kicker = element(input.document, "p", "provider-model-settings__kicker", "Coach settings");
  const title = element(input.document, "h2", undefined, "Settings");
  title.id = "provider-model-settings-title";
  const intro = element(
    input.document,
    "p",
    "provider-model-settings__intro",
    "Choose the coach route and conversation rhythm, manage local credentials, and review the currently connected training account.",
  );
  intro.id = "provider-model-settings-intro";
  heading.append(kicker, title, intro);
  const close = element(input.document, "button", "provider-model-settings__close", "Close");
  close.type = "button";
  close.setAttribute("aria-label", "Close coach settings");
  header.append(heading, close);

  const body = element(input.document, "div", "settings-sections");
  layout.append(header, body);
  dialog.append(layout);
  input.actionHost.insertBefore(opener, input.before ?? null);
  input.document.body.append(dialog);

  let disposed = false;
  let handlers:
    | {
        readonly onOpen: () => void;
        readonly onClose: () => void;
      }
    | undefined;
  const savingOwners = new Set<string>();
  const mutationListeners = new Set<(active: boolean) => void>();
  const focusableProviders = new Set<() => readonly HTMLElement[]>();

  const notifyMutation = (): void => {
    const active = savingOwners.size > 0;
    close.disabled = active;
    if (active) dialog.setAttribute("aria-busy", "true");
    else dialog.removeAttribute("aria-busy");
    for (const listener of mutationListeners) listener(active);
  };

  const requestClose = (): void => {
    if (!disposed && savingOwners.size === 0) handlers?.onClose();
  };
  const onOpen = (): void => {
    if (disposed) return;
    if (!dialog.open) {
      dialog.showModal();
      opener.setAttribute("aria-expanded", "true");
      close.focus();
    }
    handlers?.onOpen();
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
    const focusable = [
      close,
      ...Array.from(focusableProviders).flatMap((provider) => provider()),
    ].filter(isFocusable);
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

  opener.addEventListener("click", onOpen);
  close.addEventListener("click", requestClose);
  dialog.addEventListener("cancel", onCancel);
  dialog.addEventListener("click", onBackdropClick);
  dialog.addEventListener("keydown", onKeyDown);

  return {
    body,
    get mutationActive() {
      return savingOwners.size > 0;
    },
    bind(nextHandlers) {
      handlers = nextHandlers;
    },
    open() {
      if (disposed || dialog.open) return;
      dialog.showModal();
      opener.setAttribute("aria-expanded", "true");
      close.focus();
    },
    requestClose,
    close() {
      if (disposed) return;
      if (dialog.open) dialog.close();
      opener.setAttribute("aria-expanded", "false");
      opener.focus();
    },
    beginMutation(owner) {
      if (disposed || savingOwners.size > 0) return null;
      savingOwners.add(owner);
      notifyMutation();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        savingOwners.delete(owner);
        notifyMutation();
      };
    },
    setSectionSaving(owner, saving) {
      if (disposed) return;
      const wasActive = savingOwners.size > 0;
      if (saving) savingOwners.add(owner);
      else savingOwners.delete(owner);
      if (wasActive !== savingOwners.size > 0) notifyMutation();
    },
    subscribeToMutation(listener) {
      if (disposed) return () => {};
      mutationListeners.add(listener);
      listener(savingOwners.size > 0);
      return () => mutationListeners.delete(listener);
    },
    registerFocusables(values) {
      if (disposed) return () => {};
      focusableProviders.add(values);
      return () => focusableProviders.delete(values);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      handlers = undefined;
      savingOwners.clear();
      mutationListeners.clear();
      focusableProviders.clear();
      opener.removeEventListener("click", onOpen);
      close.removeEventListener("click", requestClose);
      dialog.removeEventListener("cancel", onCancel);
      dialog.removeEventListener("click", onBackdropClick);
      dialog.removeEventListener("keydown", onKeyDown);
      if (dialog.open) dialog.close();
      opener.remove();
      dialog.remove();
    },
  };
}
