import type { ReleaseNotesView } from "./controller.js";

const UNAVAILABLE_COPY =
  "Release notes aren’t available right now. Check your connection and try again.";

function element<K extends keyof HTMLElementTagNameMap>(
  document: Document,
  name: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const value = document.createElement(name);
  if (className !== undefined) value.className = className;
  return value;
}

export function createReleaseNotesView(input: {
  readonly document: Document;
  readonly actionHost: HTMLElement;
  readonly before?: Node | null;
}): ReleaseNotesView {
  const opener = element(input.document, "button", "release-notes-button");
  opener.type = "button";
  opener.textContent = "What’s new";
  opener.title = "What’s new";
  opener.setAttribute("aria-label", "What’s new");
  opener.setAttribute("aria-haspopup", "dialog");
  opener.setAttribute("aria-controls", "release-notes-dialog");
  opener.setAttribute("aria-expanded", "false");

  const dialog = element(input.document, "dialog", "release-notes-dialog");
  dialog.id = "release-notes-dialog";
  dialog.setAttribute("aria-labelledby", "release-notes-title");
  dialog.setAttribute("aria-modal", "true");

  const header = element(input.document, "header", "release-notes__header");
  const title = element(input.document, "h2");
  title.id = "release-notes-title";
  title.textContent = "What’s new";
  const close = element(input.document, "button", "release-notes__close");
  close.type = "button";
  close.setAttribute("aria-label", "Close release notes");
  close.textContent = "Close";
  header.append(title, close);

  const content = element(input.document, "div", "release-notes__content");
  content.setAttribute("role", "status");
  content.setAttribute("aria-live", "polite");
  content.setAttribute("aria-atomic", "true");

  const actions = element(input.document, "footer", "release-notes__actions");
  const retry = element(input.document, "button", "release-notes__retry");
  retry.type = "button";
  retry.textContent = "Retry";
  retry.hidden = true;
  const fullRelease = element(input.document, "a", "release-notes__full-release");
  fullRelease.textContent = "View full release";
  fullRelease.target = "_blank";
  fullRelease.rel = "noopener noreferrer";
  fullRelease.hidden = true;
  actions.append(retry, fullRelease);
  dialog.append(header, content, actions);

  input.actionHost.insertBefore(opener, input.before ?? null);
  input.document.body.append(dialog);

  let disposed = false;
  let handlers:
    | {
        readonly onOpen: () => void;
        readonly onRetry: () => void;
        readonly onClose: () => void;
      }
    | undefined;

  const onOpen = (): void => {
    if (!disposed) handlers?.onOpen();
  };
  const onRetry = (): void => {
    if (!disposed && !retry.disabled) handlers?.onRetry();
  };
  const onClose = (): void => {
    if (!disposed) handlers?.onClose();
  };
  const onCancel = (event: Event): void => {
    event.preventDefault();
    onClose();
  };
  opener.addEventListener("click", onOpen);
  retry.addEventListener("click", onRetry);
  close.addEventListener("click", onClose);
  dialog.addEventListener("cancel", onCancel);

  const setFullRelease = (releaseUrl: string | null): void => {
    fullRelease.hidden = releaseUrl === null;
    if (releaseUrl === null) fullRelease.removeAttribute("href");
    else fullRelease.href = releaseUrl;
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
    renderLoading() {
      if (disposed) return;
      dialog.setAttribute("aria-busy", "true");
      title.textContent = "What’s new";
      const loading = element(input.document, "p", "release-notes__message");
      loading.textContent = "Loading release notes…";
      content.replaceChildren(loading);
      retry.hidden = true;
      retry.disabled = true;
      setFullRelease(null);
    },
    renderAvailable(result) {
      if (disposed) return;
      dialog.removeAttribute("aria-busy");
      title.textContent = `What’s new in ${result.version}`;
      if (result.notes.length === 0) {
        const empty = element(input.document, "p", "release-notes__message");
        empty.textContent = "No athlete-facing changes were listed for this release.";
        content.replaceChildren(empty);
      } else {
        const list = element(input.document, "ol", "release-notes__list");
        for (const note of result.notes) {
          const item = element(input.document, "li");
          item.textContent = note;
          list.append(item);
        }
        content.replaceChildren(list);
      }
      retry.hidden = true;
      retry.disabled = true;
      setFullRelease(result.releaseUrl);
    },
    renderUnavailable({ releaseUrl }) {
      if (disposed) return;
      dialog.removeAttribute("aria-busy");
      title.textContent = "What’s new";
      const message = element(input.document, "p", "release-notes__message");
      message.textContent = UNAVAILABLE_COPY;
      content.replaceChildren(message);
      retry.hidden = false;
      retry.disabled = false;
      setFullRelease(releaseUrl);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      handlers = undefined;
      opener.removeEventListener("click", onOpen);
      retry.removeEventListener("click", onRetry);
      close.removeEventListener("click", onClose);
      dialog.removeEventListener("cancel", onCancel);
      if (dialog.open) dialog.close();
      opener.remove();
      dialog.remove();
    },
  };
}
