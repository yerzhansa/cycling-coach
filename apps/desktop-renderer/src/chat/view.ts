import type { ChatView } from "./controller.js";
import type { ChatTranscriptMessage } from "../turn-state.js";

type RenderedMessage = Pick<ChatTranscriptMessage, "role" | "text" | "delivery">;

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
  input.composerHost.append(noticeHost, form);

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
  let renderedMessages: readonly RenderedMessage[] = [];
  let renderedNotice: string | null = null;

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
        submit.disabled = state.status === "streaming" || workBlocked;
        textarea.disabled = state.status === "streaming" || workBlocked;
        const dialogRequested =
          state.session.resetPhase === "confirming" || state.session.resetPhase === "resetting";
        const resetCompleted = state.session.resetCount !== renderedResetCount;
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
        const nextMessages = state.messages
          .filter((message) => message.role === "athlete" || message.text.length > 0)
          .map(({ role, text, delivery }) => ({ role, text, delivery }));
        const messagesChanged =
          nextMessages.length !== renderedMessages.length ||
          nextMessages.some((message, index) => {
            const rendered = renderedMessages[index];
            return (
              rendered === undefined ||
              message.role !== rendered.role ||
              message.text !== rendered.text ||
              message.delivery !== rendered.delivery
            );
          });
        if (messagesChanged) {
          const rows = nextMessages.map((message) => {
            const article = document.createElement("article");
            article.className = `chat-message chat-message--${message.role}`;
            article.dataset.delivery = message.delivery;
            const role = document.createElement("p");
            role.className = "chat-message__role";
            role.textContent = message.role === "athlete" ? "You" : "Coach";
            const text = document.createElement("p");
            text.className = "chat-message__text";
            text.textContent = message.text;
            article.append(role, text);
            return article;
          });
          messages.replaceChildren(...rows);
          renderedMessages = nextMessages;
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
      form.removeEventListener("submit", onSubmit);
      textarea.removeEventListener("keydown", onKeydown);
      retry.removeEventListener("click", onRetry);
      newConversation.removeEventListener("click", onOpenNewConversation);
      cancelReset.removeEventListener("click", onCancelNewConversation);
      confirmReset.removeEventListener("click", onConfirmNewConversation);
      dialog.removeEventListener("cancel", onDialogCancel);
      if (dialog.open) dialog.close();
      transcript.remove();
      form.remove();
      noticeHost.remove();
      newConversation.remove();
      dialog.remove();
    },
  };
}
