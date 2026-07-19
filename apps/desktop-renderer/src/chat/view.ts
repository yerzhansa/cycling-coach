import type { ChatView } from "./controller.js";

export interface MountedChatView {
  readonly view: ChatView;
  bind(input: { readonly onSubmit: (message: string) => void; readonly onRetry: () => void }): void;
  dispose(): void;
}

export function mountChatView(input: {
  readonly conversation: HTMLElement;
  readonly thread: HTMLElement;
  readonly composerHost: HTMLElement;
}): MountedChatView {
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
  input.composerHost.append(form);

  let handlers:
    | { readonly onSubmit: (message: string) => void; readonly onRetry: () => void }
    | undefined;
  let disposed = false;

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
  form.addEventListener("submit", onSubmit);
  textarea.addEventListener("keydown", onKeydown);
  retry.addEventListener("click", onRetry);

  return {
    view: {
      render(state) {
        if (disposed) return;
        const followsLatest =
          input.conversation.scrollHeight -
            input.conversation.scrollTop -
            input.conversation.clientHeight <=
          80;
        const rows = state.messages.map((message) => {
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
        if (followsLatest) input.conversation.scrollTop = input.conversation.scrollHeight;
        const contractCopy = state.activeTurn?.error?.athleteMessage ?? null;
        const visibleNotice = contractCopy ?? state.progress;
        notice.hidden = visibleNotice === null;
        notice.textContent = visibleNotice ?? "";
        retry.hidden = state.status !== "interrupted";
        submit.disabled = state.status === "streaming";
        textarea.disabled = state.status === "streaming";
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
    },
  };
}
