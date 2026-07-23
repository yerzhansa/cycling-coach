import type { ChatView } from "./controller.js";
import type { ChatTranscriptMessage } from "../turn-state.js";
import { renderCoachMarkdown } from "./markdown.js";

interface RenderedMessage {
  readonly article: HTMLElement;
  readonly roleNode: HTMLElement;
  readonly textNode: HTMLElement;
  streamTextNode: Text | null;
  role: ChatTranscriptMessage["role"];
  text: string;
  delivery: ChatTranscriptMessage["delivery"];
}

interface PendingShortcutFocus {
  readonly button: HTMLButtonElement;
  observedTurnLock: boolean;
}

const COMPOSER_CLEARANCE_PROPERTY = "--chat-composer-clearance";

const COACHING_SHORTCUTS = Object.freeze([
  Object.freeze({ command: "/plan", label: "Build a plan" }),
  Object.freeze({ command: "/workout", label: "Today’s workout" }),
  Object.freeze({ command: "/status", label: "Training status" }),
  Object.freeze({ command: "/review", label: "Review last session" }),
]);

export interface MountedChatView {
  readonly view: ChatView;
  readonly noticeHost: HTMLElement;
  bind(input: {
    readonly onSubmit: (message: string) => void;
    readonly onRetry: () => void;
    readonly onOpenNewConversation: () => void;
    readonly onCancelNewConversation: () => void;
    readonly onConfirmNewConversation: () => void;
  }): void;
  dispose(): void;
}

export function mountChatView(input: {
  readonly conversation: HTMLElement;
  readonly thread: HTMLElement;
  readonly composerHost: HTMLElement;
  readonly actionHost?: HTMLElement;
}): MountedChatView {
  const actionHost = input.actionHost ?? document.createElement("div");
  const newConversation = document.createElement("button");
  newConversation.type = "button";
  newConversation.className = "new-conversation-button";
  newConversation.textContent = "New conversation";
  const dialog = document.createElement("dialog");
  dialog.className = "new-conversation-dialog";
  dialog.setAttribute("aria-labelledby", "new-conversation-title");
  dialog.setAttribute("aria-describedby", "new-conversation-description");
  dialog.setAttribute("aria-modal", "true");
  const dialogTitle = document.createElement("h2");
  dialogTitle.id = "new-conversation-title";
  dialogTitle.textContent = "Start a new conversation?";
  const dialogDescription = document.createElement("p");
  dialogDescription.id = "new-conversation-description";
  dialogDescription.textContent =
    "Your visible conversation will be cleared. Your training data and saved coach memory will remain.";
  const dialogActions = document.createElement("div");
  dialogActions.className = "new-conversation-dialog__actions";
  const cancelReset = document.createElement("button");
  cancelReset.type = "button";
  cancelReset.textContent = "Cancel";
  const confirmReset = document.createElement("button");
  confirmReset.type = "button";
  confirmReset.className = "new-conversation-dialog__confirm";
  confirmReset.textContent = "Start new conversation";
  dialogActions.append(cancelReset, confirmReset);
  dialog.append(dialogTitle, dialogDescription, dialogActions);
  actionHost.insertBefore(newConversation, actionHost.firstChild);
  actionHost.append(dialog);

  const transcript = document.createElement("section");
  transcript.className = "chat-transcript";
  transcript.setAttribute("role", "log");
  transcript.setAttribute("aria-live", "polite");
  transcript.setAttribute("aria-relevant", "additions text");
  transcript.setAttribute("aria-atomic", "false");
  transcript.setAttribute("aria-label", "Coach conversation");
  const messages = document.createElement("div");
  messages.className = "chat-messages";
  const notice = document.createElement("p");
  notice.className = "chat-notice";
  notice.hidden = true;
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "chat-retry";
  retry.textContent = "Retry message";
  retry.hidden = true;
  transcript.append(messages, notice, retry);
  input.thread.append(transcript);

  input.composerHost.replaceChildren();
  const form = document.createElement("form");
  form.className = "composer";
  const noticeHost = document.createElement("div");
  noticeHost.className = "chat-notice-host";
  const resetStatus = document.createElement("p");
  resetStatus.className = "new-conversation-status";
  resetStatus.setAttribute("role", "status");
  resetStatus.setAttribute("aria-live", "polite");
  noticeHost.append(resetStatus);
  const shortcutGroup = document.createElement("div");
  shortcutGroup.className = "coaching-shortcuts";
  shortcutGroup.setAttribute("role", "group");
  shortcutGroup.setAttribute("aria-label", "Coaching shortcuts");
  const shortcutControls = COACHING_SHORTCUTS.map((shortcut) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "coaching-shortcut";
    button.setAttribute("aria-label", `${shortcut.label}, ${shortcut.command} command`);
    const buttonLabel = document.createElement("span");
    buttonLabel.className = "coaching-shortcut__label";
    buttonLabel.textContent = shortcut.label;
    const command = document.createElement("span");
    command.className = "coaching-shortcut__command";
    command.textContent = shortcut.command;
    button.append(buttonLabel, command);
    shortcutGroup.append(button);
    return { button, shortcut };
  });
  const label = document.createElement("label");
  label.className = "chat-composer__label";
  label.htmlFor = "message";
  label.textContent = "Message your coach";
  const controls = document.createElement("div");
  controls.className = "chat-composer__controls";
  const textarea = document.createElement("textarea");
  textarea.id = "message";
  textarea.rows = 2;
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.setAttribute("aria-label", "Send message");
  submit.textContent = "↑";
  controls.append(textarea, submit);
  form.append(label, controls);
  input.composerHost.append(noticeHost, shortcutGroup, form);

  let handlers:
    | {
        readonly onSubmit: (message: string) => void;
        readonly onRetry: () => void;
        readonly onOpenNewConversation: () => void;
        readonly onCancelNewConversation: () => void;
        readonly onConfirmNewConversation: () => void;
      }
    | undefined;
  let disposed = false;
  let renderedResetCount = 0;
  let renderedAnnouncement: string | null = null;
  const renderedMessages = new Map<string, RenderedMessage>();
  let renderedNotice: string | null = null;
  let pendingShortcutFocus: PendingShortcutFocus | undefined;

  const updateComposerClearance = (): void => {
    if (disposed) return;
    const height = input.composerHost.getBoundingClientRect().height;
    if (Number.isFinite(height) && height > 0) {
      input.conversation.style.setProperty(COMPOSER_CLEARANCE_PROPERTY, `${height}px`);
    }
  };
  updateComposerClearance();
  const composerResizeObserver =
    typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(updateComposerClearance);
  composerResizeObserver?.observe(input.composerHost);

  const onSubmit = (event: SubmitEvent): void => {
    event.preventDefault();
    if (submit.disabled) return;
    const value = textarea.value;
    if (!/\S/u.test(value)) return;
    textarea.value = "";
    handlers?.onSubmit(value);
  };
  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      form.requestSubmit();
    }
  };
  const onRetry = (): void => handlers?.onRetry();
  const onOpenNewConversation = (): void => {
    if (newConversation.disabled || newConversation.getAttribute("aria-disabled") === "true")
      return;
    handlers?.onOpenNewConversation();
  };
  const onCancelNewConversation = (): void => handlers?.onCancelNewConversation();
  const onConfirmNewConversation = (): void => handlers?.onConfirmNewConversation();
  const onDialogCancel = (event: Event): void => {
    event.preventDefault();
    if (!cancelReset.disabled) handlers?.onCancelNewConversation();
  };
  const onDocumentFocusIn = (event: FocusEvent): void => {
    if (
      pendingShortcutFocus !== undefined &&
      event.target !== pendingShortcutFocus.button &&
      event.target !== document.body &&
      event.target !== document.documentElement
    ) {
      pendingShortcutFocus = undefined;
    }
  };
  const shortcutListeners = shortcutControls.map(({ button, shortcut }) => {
    const listener = (event: MouseEvent): void => {
      if (disposed || button.disabled) return;
      const onShortcutSubmit = handlers?.onSubmit;
      if (onShortcutSubmit === undefined) return;
      pendingShortcutFocus =
        event.detail === 0 && document.activeElement === button
          ? { button, observedTurnLock: false }
          : undefined;
      onShortcutSubmit(shortcut.command);
    };
    button.addEventListener("click", listener);
    return { button, listener };
  });
  document.addEventListener("focusin", onDocumentFocusIn);
  form.addEventListener("submit", onSubmit);
  textarea.addEventListener("keydown", onKeydown);
  retry.addEventListener("click", onRetry);
  newConversation.addEventListener("click", onOpenNewConversation);
  cancelReset.addEventListener("click", onCancelNewConversation);
  confirmReset.addEventListener("click", onConfirmNewConversation);
  dialog.addEventListener("cancel", onDialogCancel);

  return {
    noticeHost,
    view: {
      render(state, controls) {
        if (disposed) return;
        const messageIds = new Set(state.messages.map((message) => message.id));
        if (messageIds.size !== state.messages.length) {
          throw new TypeError("duplicate chat message id");
        }
        const nextMessages = state.messages.filter(
          (message) => message.role === "athlete" || message.text.length > 0,
        );
        const nextIds = new Set(nextMessages.map((message) => message.id));
        const workBlocked =
          controls?.workBlocked ??
          (state.session.resetPhase === "confirming" || state.session.resetPhase === "resetting");
        const newConversationUnavailable =
          controls?.newConversationDisabled ??
          (state.session.presence !== "present" ||
            state.session.resetPhase !== "idle" ||
            state.status === "streaming");
        const focusableUncertainOpener =
          newConversationUnavailable && state.session.resetPhase === "uncertain";
        newConversation.disabled = newConversationUnavailable && !focusableUncertainOpener;
        if (focusableUncertainOpener) newConversation.setAttribute("aria-disabled", "true");
        else newConversation.removeAttribute("aria-disabled");
        const resetPending = state.session.resetPhase === "resetting";
        if (resetPending) dialog.setAttribute("aria-busy", "true");
        else dialog.removeAttribute("aria-busy");
        cancelReset.disabled = resetPending;
        confirmReset.disabled = resetPending;
        retry.disabled = workBlocked;
        const composerDisabled = state.status === "streaming" || workBlocked;
        for (const { button } of shortcutControls) button.disabled = composerDisabled;
        submit.disabled = composerDisabled;
        textarea.disabled = composerDisabled;
        const dialogRequested =
          state.session.resetPhase === "confirming" || state.session.resetPhase === "resetting";
        const resetCompleted = state.session.resetCount !== renderedResetCount;
        if (pendingShortcutFocus !== undefined) {
          if (state.session.resetPhase !== "idle" || resetCompleted) {
            pendingShortcutFocus = undefined;
          } else if (composerDisabled) {
            pendingShortcutFocus.observedTurnLock = true;
          } else if (pendingShortcutFocus.observedTurnLock) {
            const { button } = pendingShortcutFocus;
            pendingShortcutFocus = undefined;
            const activeElement = document.activeElement;
            if (
              activeElement !== button &&
              (activeElement === null ||
                activeElement === document.body ||
                activeElement === document.documentElement)
            ) {
              button.focus();
            }
          }
        }
        if (dialogRequested && !dialog.open) {
          dialog.showModal();
          cancelReset.focus();
        } else if (!dialogRequested && dialog.open) {
          dialog.close();
          if (resetCompleted) {
            textarea.value = "";
            textarea.focus();
          } else {
            newConversation.focus();
          }
        } else if (resetCompleted) {
          textarea.value = "";
          textarea.focus();
        }
        renderedResetCount = state.session.resetCount;
        if (state.session.announcement !== renderedAnnouncement) {
          renderedAnnouncement = state.session.announcement;
          resetStatus.textContent = renderedAnnouncement ?? "";
        }
        const followsLatest =
          input.conversation.scrollHeight -
            input.conversation.scrollTop -
            input.conversation.clientHeight <=
          80;
        if (nextMessages.length === 0 && renderedMessages.size > 0) {
          messages.textContent = "";
          renderedMessages.clear();
        } else {
          for (const [id, rendered] of renderedMessages) {
            if (!nextIds.has(id)) {
              rendered.article.remove();
              renderedMessages.delete(id);
            }
          }
          nextMessages.forEach((message, index) => {
            let rendered = renderedMessages.get(message.id);
            if (rendered === undefined) {
              const article = document.createElement("article");
              article.dataset.messageId = message.id;
              const roleNode = document.createElement("p");
              roleNode.className = "chat-message__role";
              const textNode = document.createElement("div");
              textNode.className = "chat-message__text";
              article.append(roleNode, textNode);
              rendered = {
                article,
                roleNode,
                textNode,
                streamTextNode: null,
                role: message.role,
                text: message.text,
                delivery: message.delivery,
              };
              renderedMessages.set(message.id, rendered);
              article.className = `chat-message chat-message--${message.role}`;
              article.dataset.delivery = message.delivery;
              roleNode.textContent = message.role === "athlete" ? "You" : "Coach";
              if (message.role === "athlete") article.setAttribute("aria-live", "off");
              article.setAttribute("aria-atomic", message.role === "coach" ? "true" : "false");
              if (message.role === "coach" && message.delivery === "streaming") {
                article.setAttribute("aria-busy", "true");
              }
              if (message.role === "coach" && message.delivery === "streaming") {
                rendered.streamTextNode = document.createTextNode(message.text);
                textNode.append(rendered.streamTextNode);
              } else if (message.role === "coach") {
                renderCoachMarkdown(textNode, message.text);
              } else {
                textNode.textContent = message.text;
              }
            } else {
              const roleChanged = message.role !== rendered.role;
              const wasBusy = rendered.role === "coach" && rendered.delivery === "streaming";
              const isBusy = message.role === "coach" && message.delivery === "streaming";
              if (!wasBusy && isBusy) rendered.article.setAttribute("aria-busy", "true");
              if (roleChanged) {
                rendered.article.className = `chat-message chat-message--${message.role}`;
                rendered.roleNode.textContent = message.role === "athlete" ? "You" : "Coach";
                if (message.role === "athlete") rendered.article.setAttribute("aria-live", "off");
                else rendered.article.removeAttribute("aria-live");
                rendered.article.setAttribute(
                  "aria-atomic",
                  message.role === "coach" ? "true" : "false",
                );
              }
              if (message.delivery !== rendered.delivery) {
                rendered.article.dataset.delivery = message.delivery;
              }
              if (roleChanged || message.text !== rendered.text || wasBusy !== isBusy) {
                if (isBusy) {
                  const appendDelta = controls?.appendDelta;
                  if (
                    !roleChanged &&
                    rendered.streamTextNode !== null &&
                    appendDelta?.messageId === message.id &&
                    appendDelta.previousTextLength === rendered.text.length &&
                    appendDelta.nextTextLength === message.text.length &&
                    appendDelta.nextTextLength ===
                      appendDelta.previousTextLength + appendDelta.delta.length
                  ) {
                    rendered.streamTextNode.appendData(appendDelta.delta);
                  } else {
                    rendered.streamTextNode = document.createTextNode(message.text);
                    rendered.textNode.replaceChildren(rendered.streamTextNode);
                  }
                } else if (message.role === "coach") {
                  renderCoachMarkdown(rendered.textNode, message.text);
                  rendered.streamTextNode = null;
                } else {
                  rendered.textNode.textContent = message.text;
                  rendered.streamTextNode = null;
                }
              }
              if (wasBusy && !isBusy) rendered.article.removeAttribute("aria-busy");
              rendered.role = message.role;
              rendered.text = message.text;
              rendered.delivery = message.delivery;
            }
            const currentAtIndex = messages.children.item(index);
            if (currentAtIndex !== rendered.article) {
              messages.insertBefore(rendered.article, currentAtIndex);
            }
          });
        }
        if (followsLatest) input.conversation.scrollTop = input.conversation.scrollHeight;
        const contractCopy = state.activeTurn?.error?.athleteMessage ?? null;
        const visibleNotice = contractCopy ?? state.progress;
        notice.hidden = visibleNotice === null;
        if (visibleNotice !== renderedNotice) {
          renderedNotice = visibleNotice;
          notice.textContent = renderedNotice ?? "";
        }
        retry.hidden = state.status !== "interrupted";
        input.conversation.dataset.chatStatus = state.status;
      },
    },
    bind(next) {
      handlers = next;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      handlers = undefined;
      pendingShortcutFocus = undefined;
      composerResizeObserver?.disconnect();
      input.conversation.style.removeProperty(COMPOSER_CLEARANCE_PROPERTY);
      form.removeEventListener("submit", onSubmit);
      textarea.removeEventListener("keydown", onKeydown);
      retry.removeEventListener("click", onRetry);
      newConversation.removeEventListener("click", onOpenNewConversation);
      cancelReset.removeEventListener("click", onCancelNewConversation);
      confirmReset.removeEventListener("click", onConfirmNewConversation);
      dialog.removeEventListener("cancel", onDialogCancel);
      document.removeEventListener("focusin", onDocumentFocusIn);
      for (const { button, listener } of shortcutListeners) {
        button.removeEventListener("click", listener);
      }
      if (dialog.open) dialog.close();
      transcript.remove();
      shortcutGroup.remove();
      form.remove();
      noticeHost.remove();
      newConversation.remove();
      dialog.remove();
    },
  };
}
