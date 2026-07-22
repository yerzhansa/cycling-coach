import { beforeEach, describe, expect, it, vi } from "vitest";
import { mountChatView } from "../src/chat/view.js";
import { EMPTY_CHAT_STATE, reduceChatState, type ChatState } from "../src/turn-state.js";

class FakeElement {
  readonly children: FakeElement[] = [];
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Set<(event: never) => void>>();
  readonly dataset: Record<string, string> = {};
  className = "";
  hidden = false;
  disabled = false;
  value = "";
  type = "";
  id = "";
  rows = 0;
  htmlFor = "";
  removed = false;
  open = false;
  scrollHeight = 0;
  scrollTop = 0;
  clientHeight = 0;
  textContentMutationCount = 0;
  replaceChildrenMutationCount = 0;
  private ownText = "";

  constructor(readonly tagName: string) {}

  get firstChild(): FakeElement | null {
    return this.children[0] ?? null;
  }

  get textContent(): string {
    return this.ownText + this.children.map((child) => child.textContent).join("");
  }

  set textContent(value: string) {
    this.textContentMutationCount += 1;
    this.ownText = value;
    this.children.splice(0);
  }

  append(...nodes: Array<FakeElement | string>): void {
    for (const node of nodes) {
      this.children.push(typeof node === "string" ? new FakeElement("#text") : node);
      if (typeof node === "string") this.children.at(-1)!.textContent = node;
    }
  }

  insertBefore(node: FakeElement, reference: FakeElement | null): void {
    const index = reference === null ? -1 : this.children.indexOf(reference);
    if (index === -1) this.children.push(node);
    else this.children.splice(index, 0, node);
  }

  replaceChildren(...nodes: FakeElement[]): void {
    this.replaceChildrenMutationCount += 1;
    this.ownText = "";
    this.children.splice(0, this.children.length, ...nodes);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  addEventListener(name: string, listener: (event: never) => void): void {
    const listeners = this.listeners.get(name) ?? new Set();
    listeners.add(listener);
    this.listeners.set(name, listeners);
  }

  removeEventListener(name: string, listener: (event: never) => void): void {
    this.listeners.get(name)?.delete(listener);
  }

  dispatch(name: string, event: Record<string, unknown> = {}): void {
    for (const listener of this.listeners.get(name) ?? []) listener(event as never);
  }

  requestSubmit(): void {
    this.dispatch("submit", { preventDefault() {} });
  }

  showModal(): void {
    this.open = true;
  }

  close(): void {
    this.open = false;
    this.dispatch("close");
  }

  focus(): void {
    if (this.disabled) return;
    (globalThis.document as unknown as FakeDocument).activeElement = this;
  }

  remove(): void {
    this.removed = true;
  }
}

class FakeDocument {
  activeElement: FakeElement | null = null;

  createElement(name: string): FakeElement {
    return new FakeElement(name);
  }
}

function find(root: FakeElement, predicate: (node: FakeElement) => boolean): FakeElement {
  if (predicate(root)) return root;
  for (const child of root.children) {
    try {
      return find(child, predicate);
    } catch {}
  }
  throw new Error("Element not found");
}

function findAll(root: FakeElement, predicate: (node: FakeElement) => boolean): FakeElement[] {
  return [
    ...(predicate(root) ? [root] : []),
    ...root.children.flatMap((child) => findAll(child, predicate)),
  ];
}

function occurrences(value: string, part: string): number {
  return value.split(part).length - 1;
}

function submittedState(): ChatState {
  return reduceChatState(EMPTY_CHAT_STATE, {
    type: "submit",
    requestKey: 1,
    userMessage: "How should I train?",
    userMessageId: "message-1",
    assistantMessageId: "message-2",
    includeUser: true,
  });
}

const emptyState: ChatState = EMPTY_CHAT_STATE;

beforeEach(() => {
  Object.assign(globalThis, {
    document: new FakeDocument(),
    HTMLElement: FakeElement,
  });
});

describe("chat view", () => {
  it("renders the athlete row without an empty coach row while awaiting a response", () => {
    const thread = new FakeElement("div");
    const mounted = mountChatView({
      conversation: new FakeElement("main") as never,
      thread: thread as never,
      composerHost: new FakeElement("div") as never,
    });
    const state = reduceChatState(EMPTY_CHAT_STATE, {
      type: "submit",
      requestKey: 1,
      userMessage: "How should I train?",
      userMessageId: "message-1",
      assistantMessageId: "message-2",
      includeUser: true,
    });

    mounted.view.render(state);

    expect(findAll(thread, (node) => node.className.includes("chat-message--athlete")).length).toBe(
      1,
    );
    expect(findAll(thread, (node) => node.className.includes("chat-message--coach")).length).toBe(
      0,
    );
  });

  it("renders no-draft reauthentication once as a notice and re-enables the composer", () => {
    const thread = new FakeElement("div");
    const composerHost = new FakeElement("div");
    const mounted = mountChatView({
      conversation: new FakeElement("main") as never,
      thread: thread as never,
      composerHost: composerHost as never,
    });
    const reauthenticationCopy =
      "Your ChatGPT sign-in is no longer valid. Open Setup and sign in again.";
    let state = reduceChatState(submittedState(), {
      type: "event",
      requestKey: 1,
      event: {
        type: "error",
        turnId: "turn-1",
        chatId: "desktop",
        error_class: "unknown",
        kind: "provider-auth",
        athleteMessage: reauthenticationCopy,
        overflowAttempts: 0,
        timeoutAttempts: 0,
        rateLimitAttempts: 0,
        duration_ms: 1,
        compactions: 0,
      },
    });
    state = reduceChatState(state, {
      type: "fail",
      requestKey: 1,
      copy: "The coach couldn't respond. Please try again.",
    });

    mounted.view.render(state);

    expect(occurrences(thread.textContent, reauthenticationCopy)).toBe(1);
    expect(thread.textContent).not.toContain("The coach couldn't respond");
    expect(findAll(thread, (node) => node.className.includes("chat-message--coach")).length).toBe(
      0,
    );
    expect(find(thread, (node) => node.className === "chat-retry").hidden).toBe(true);
    expect(find(composerHost, (node) => node.tagName === "textarea").disabled).toBe(false);
    expect(find(composerHost, (node) => node.tagName === "button").disabled).toBe(false);
  });

  it("renders a partial coach draft and the reauthentication notice once each", () => {
    const thread = new FakeElement("div");
    const mounted = mountChatView({
      conversation: new FakeElement("main") as never,
      thread: thread as never,
      composerHost: new FakeElement("div") as never,
    });
    const reauthenticationCopy =
      "Your ChatGPT sign-in is no longer valid. Open Setup and sign in again.";
    let state = reduceChatState(submittedState(), {
      type: "event",
      requestKey: 1,
      event: { type: "text_delta", turnId: "turn-1", delta: "Partial coach draft" },
    });
    state = reduceChatState(state, {
      type: "event",
      requestKey: 1,
      event: {
        type: "error",
        turnId: "turn-1",
        chatId: "desktop",
        error_class: "unknown",
        kind: "provider-auth",
        athleteMessage: reauthenticationCopy,
        overflowAttempts: 0,
        timeoutAttempts: 0,
        rateLimitAttempts: 0,
        duration_ms: 1,
        compactions: 0,
      },
    });
    state = reduceChatState(state, {
      type: "fail",
      requestKey: 1,
      copy: "The coach couldn't respond. Please try again.",
    });

    mounted.view.render(state);

    expect(occurrences(thread.textContent, "Partial coach draft")).toBe(1);
    expect(occurrences(thread.textContent, reauthenticationCopy)).toBe(1);
    expect(findAll(thread, (node) => node.className.includes("chat-message--coach")).length).toBe(
      1,
    );
  });

  it("renders canonical final text once after an error and leaves the contract notice", () => {
    const thread = new FakeElement("div");
    const composerHost = new FakeElement("div");
    const mounted = mountChatView({
      conversation: new FakeElement("main") as never,
      thread: thread as never,
      composerHost: composerHost as never,
    });
    const finalText = "Take an easy spin today.";
    const contractNotice = "Your ChatGPT sign-in is no longer valid. Open Setup and sign in again.";
    let state = reduceChatState(submittedState(), {
      type: "event",
      requestKey: 1,
      event: {
        type: "error",
        turnId: "turn-1",
        chatId: "desktop",
        error_class: "unknown",
        kind: "provider-auth",
        athleteMessage: contractNotice,
        overflowAttempts: 0,
        timeoutAttempts: 0,
        rateLimitAttempts: 0,
        duration_ms: 1,
        compactions: 0,
      },
    });
    state = reduceChatState(state, {
      type: "event",
      requestKey: 1,
      event: { type: "final-text", turnId: "turn-1", text: finalText },
    });
    state = reduceChatState(state, { type: "complete", requestKey: 1 });

    mounted.view.render(state);

    const coachRows = findAll(thread, (node) => node.className.includes("chat-message--coach"));
    expect(coachRows).toHaveLength(1);
    expect(coachRows[0]?.textContent).toContain(finalText);
    expect(coachRows[0]?.textContent.trim()).not.toBe("");
    expect(occurrences(thread.textContent, finalText)).toBe(1);
    expect(occurrences(thread.textContent, contractNotice)).toBe(1);
    expect(thread.textContent).not.toContain("The coach couldn't respond");
    expect(find(thread, (node) => node.className === "chat-retry").hidden).toBe(true);
    expect(find(composerHost, (node) => node.tagName === "textarea").disabled).toBe(false);
    expect(find(composerHost, (node) => node.tagName === "button").disabled).toBe(false);
  });

  it("renders generic failure copy once as a notice without an empty coach row", () => {
    const thread = new FakeElement("div");
    const mounted = mountChatView({
      conversation: new FakeElement("main") as never,
      thread: thread as never,
      composerHost: new FakeElement("div") as never,
    });
    const failureCopy = "The coach couldn't respond. Please try again.";
    const state = reduceChatState(submittedState(), {
      type: "fail",
      requestKey: 1,
      copy: failureCopy,
    });

    mounted.view.render(state);

    expect(occurrences(thread.textContent, failureCopy)).toBe(1);
    expect(findAll(thread, (node) => node.className.includes("chat-message--coach")).length).toBe(
      0,
    );
  });

  it("renders an empty interruption notice and retry without an empty coach row", () => {
    const thread = new FakeElement("div");
    const mounted = mountChatView({
      conversation: new FakeElement("main") as never,
      thread: thread as never,
      composerHost: new FakeElement("div") as never,
    });
    const interruptionCopy = "Connection interrupted. Your partial response is preserved.";
    const state = reduceChatState(submittedState(), {
      type: "interrupt",
      requestKey: 1,
      copy: interruptionCopy,
    });

    mounted.view.render(state);

    expect(occurrences(thread.textContent, interruptionCopy)).toBe(1);
    expect(findAll(thread, (node) => node.className.includes("chat-message--coach")).length).toBe(
      0,
    );
    expect(find(thread, (node) => node.className === "chat-retry").hidden).toBe(false);
  });

  it("mutates live transcript content only when its rendered semantics change", () => {
    const actionHost = new FakeElement("div");
    const thread = new FakeElement("div");
    const mounted = mountChatView({
      conversation: new FakeElement("main") as never,
      thread: thread as never,
      composerHost: new FakeElement("div") as never,
      actionHost: actionHost as never,
    });
    const messages = find(thread, (node) => node.className === "chat-messages");
    const notice = find(thread, (node) => node.className === "chat-notice");

    mounted.view.render(emptyState);
    expect(messages.replaceChildrenMutationCount).toBe(0);
    expect(notice.textContentMutationCount).toBe(0);

    let state = submittedState();
    mounted.view.render(state);
    expect(messages.replaceChildrenMutationCount).toBe(1);
    expect(messages.textContent).toContain("How should I train?");
    expect(notice.textContentMutationCount).toBe(0);

    mounted.view.render({
      ...state,
      messages: state.messages.map((message) => ({ ...message, id: `${message.id}-clone` })),
    });
    expect(messages.replaceChildrenMutationCount).toBe(1);
    expect(notice.textContentMutationCount).toBe(0);

    state = reduceChatState(state, {
      type: "event",
      requestKey: 1,
      event: { type: "text_delta", turnId: "turn-1", delta: "Partial coach draft" },
    });
    mounted.view.render(state);
    expect(messages.replaceChildrenMutationCount).toBe(2);
    expect(messages.textContent).toContain("Partial coach draft");
    expect(notice.textContentMutationCount).toBe(0);

    state = reduceChatState(state, {
      type: "interrupt",
      requestKey: 1,
      copy: "Connection interrupted. Your partial response is preserved.",
    });
    mounted.view.render(state);
    expect(messages.replaceChildrenMutationCount).toBe(3);
    expect(notice.textContentMutationCount).toBe(1);
    expect(notice.textContent).toBe("Connection interrupted. Your partial response is preserved.");
    expect(find(thread, (node) => node.className === "chat-retry").hidden).toBe(false);

    state = reduceChatState(state, {
      type: "interrupt",
      requestKey: 1,
      copy: "Connection interrupted again. Your partial response is preserved.",
    });
    mounted.view.render(state);
    expect(messages.replaceChildrenMutationCount).toBe(3);
    expect(notice.textContentMutationCount).toBe(2);
    expect(notice.textContent).toBe(
      "Connection interrupted again. Your partial response is preserved.",
    );

    let resetState = reduceChatState(state, { type: "open-new-conversation" });
    mounted.view.render(resetState);
    resetState = reduceChatState(resetState, { type: "begin-reset" });
    mounted.view.render(resetState, { newConversationDisabled: true, workBlocked: true });
    mounted.view.render(
      {
        ...resetState,
        messages: resetState.messages.map((message) => ({ ...message })),
      },
      { newConversationDisabled: false, workBlocked: false },
    );
    expect(messages.replaceChildrenMutationCount).toBe(3);
    expect(notice.textContentMutationCount).toBe(2);

    const clearedState = reduceChatState(resetState, {
      type: "reset-succeeded",
      announcement: "New conversation started.",
    });
    mounted.view.render(clearedState);
    expect(messages.replaceChildrenMutationCount).toBe(4);
    expect(messages.children).toHaveLength(0);
    expect(notice.textContentMutationCount).toBe(3);
    expect(notice.textContent).toBe("");

    mounted.view.render({
      ...state,
      messages: state.messages.map((message) => ({ ...message })),
      session: { ...clearedState.session, presence: "present", announcement: null },
    });
    expect(messages.replaceChildrenMutationCount).toBe(5);
    expect(messages.textContent).toContain("Partial coach draft");
    expect(notice.textContentMutationCount).toBe(4);
    expect(notice.textContent).toBe(
      "Connection interrupted again. Your partial response is preserved.",
    );
  });

  it("places one notice host immediately before the composer and removes it on dispose", () => {
    const composerHost = new FakeElement("div");
    const mounted = mountChatView({
      conversation: new FakeElement("main") as never,
      thread: new FakeElement("div") as never,
      composerHost: composerHost as never,
    });
    const host = mounted.noticeHost as unknown as FakeElement;
    expect(host.className).toBe("chat-notice-host");
    expect(composerHost.children[0]).toBe(host);
    expect(composerHost.children[1]?.className).toBe("composer");
    mounted.dispose();
    expect(host.removed).toBe(true);
  });

  it("renders hostile HTML-shaped text literally in the polite log", () => {
    const conversation = new FakeElement("main");
    const thread = new FakeElement("div");
    const composerHost = new FakeElement("div");
    const mounted = mountChatView({
      conversation: conversation as never,
      thread: thread as never,
      composerHost: composerHost as never,
    });
    mounted.view.render({
      ...emptyState,
      messages: [
        {
          id: "message-1",
          role: "athlete",
          text: '<img src=x onerror="globalThis.executed=true">',
          delivery: "complete",
        },
      ],
    });
    expect(thread.textContent).toContain('<img src=x onerror="globalThis.executed=true">');
    expect((globalThis as Record<string, unknown>).executed).toBeUndefined();
    const transcript = find(thread, (node) => node.className === "chat-transcript");
    expect(transcript.attributes.get("role")).toBe("log");
    expect(transcript.attributes.get("aria-live")).toBe("polite");
  });

  it("keeps a visible label, submits original text, and disables while streaming", () => {
    const conversation = new FakeElement("main");
    const thread = new FakeElement("div");
    const composerHost = new FakeElement("div");
    const mounted = mountChatView({
      conversation: conversation as never,
      thread: thread as never,
      composerHost: composerHost as never,
    });
    const onSubmit = vi.fn();
    mounted.bind({
      onSubmit,
      onRetry: vi.fn(),
      onOpenNewConversation: vi.fn(),
      onCancelNewConversation: vi.fn(),
      onConfirmNewConversation: vi.fn(),
    });
    const label = find(composerHost, (node) => node.className === "chat-composer__label");
    const textarea = find(composerHost, (node) => node.tagName === "textarea");
    const form = find(composerHost, (node) => node.tagName === "form");
    expect(label.textContent).toBe("Message your coach");
    textarea.value = "  Keep spacing  ";
    form.dispatch("submit", { preventDefault() {} });
    expect(onSubmit).toHaveBeenCalledWith("  Keep spacing  ");
    mounted.view.render({ ...emptyState, status: "streaming" });
    const button = find(composerHost, (node) => node.tagName === "button");
    expect(textarea.disabled).toBe(true);
    expect(button.disabled).toBe(true);
  });

  it("shows the explicit retry control only for an interrupted turn", () => {
    const conversation = new FakeElement("main");
    const thread = new FakeElement("div");
    const composerHost = new FakeElement("div");
    const mounted = mountChatView({
      conversation: conversation as never,
      thread: thread as never,
      composerHost: composerHost as never,
    });
    const onRetry = vi.fn();
    mounted.bind({
      onSubmit: vi.fn(),
      onRetry,
      onOpenNewConversation: vi.fn(),
      onCancelNewConversation: vi.fn(),
      onConfirmNewConversation: vi.fn(),
    });
    mounted.view.render({ ...emptyState, status: "interrupted", progress: "Interrupted" });
    const retry = find(thread, (node) => node.className === "chat-retry");
    expect(retry.hidden).toBe(false);
    retry.dispatch("click");
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("follows streamed text only when the athlete is already near the bottom", () => {
    const conversation = new FakeElement("main");
    conversation.scrollHeight = 240;
    conversation.clientHeight = 100;
    conversation.scrollTop = 135;
    const mounted = mountChatView({
      conversation: conversation as never,
      thread: new FakeElement("div") as never,
      composerHost: new FakeElement("div") as never,
    });
    mounted.view.render({ ...emptyState, status: "streaming" });
    expect(conversation.scrollTop).toBe(240);
    conversation.scrollHeight = 400;
    conversation.scrollTop = 0;
    mounted.view.render({ ...emptyState, status: "streaming" });
    expect(conversation.scrollTop).toBe(0);
  });

  it("renders and binds the visible New conversation button with disabled states", () => {
    const actionHost = new FakeElement("div");
    const mounted = mountChatView({
      conversation: new FakeElement("main") as never,
      thread: new FakeElement("div") as never,
      composerHost: new FakeElement("div") as never,
      actionHost: actionHost as never,
    });
    const onOpenNewConversation = vi.fn();
    mounted.bind({
      onSubmit: vi.fn(),
      onRetry: vi.fn(),
      onOpenNewConversation,
      onCancelNewConversation: vi.fn(),
      onConfirmNewConversation: vi.fn(),
    });
    const button = find(actionHost, (node) => node.className === "new-conversation-button");

    mounted.view.render(emptyState);
    expect(button.textContent).toBe("New conversation");
    expect(button.disabled).toBe(true);

    const present = reduceChatState(emptyState, { type: "session-probe", hasSession: true });
    mounted.view.render(present);
    expect(button.disabled).toBe(false);
    button.dispatch("click");
    expect(onOpenNewConversation).toHaveBeenCalledTimes(1);

    mounted.view.render({ ...present, status: "streaming" });
    expect(button.disabled).toBe(true);
    mounted.view.render(present, { newConversationDisabled: true, workBlocked: false });
    expect(button.disabled).toBe(true);
  });

  it("labels the modal, focuses Cancel, and restores the opener after cancel or Escape", () => {
    const actionHost = new FakeElement("div");
    const composerHost = new FakeElement("div");
    const mounted = mountChatView({
      conversation: new FakeElement("main") as never,
      thread: new FakeElement("div") as never,
      composerHost: composerHost as never,
      actionHost: actionHost as never,
    });
    const onCancelNewConversation = vi.fn();
    mounted.bind({
      onSubmit: vi.fn(),
      onRetry: vi.fn(),
      onOpenNewConversation: vi.fn(),
      onCancelNewConversation,
      onConfirmNewConversation: vi.fn(),
    });
    const button = find(actionHost, (node) => node.className === "new-conversation-button");
    const dialog = find(actionHost, (node) => node.tagName === "dialog");
    const cancel = find(dialog, (node) => node.textContent === "Cancel");
    const textarea = find(composerHost, (node) => node.tagName === "textarea");
    textarea.value = "  exact draft  ";
    const present = reduceChatState(emptyState, { type: "session-probe", hasSession: true });
    const confirming = reduceChatState(present, { type: "open-new-conversation" });

    mounted.view.render(confirming);
    expect(dialog.open).toBe(true);
    expect(dialog.attributes.get("aria-labelledby")).toBe("new-conversation-title");
    expect(dialog.attributes.get("aria-describedby")).toBe("new-conversation-description");
    expect(dialog.attributes.get("aria-modal")).toBe("true");
    expect(dialog.textContent).toContain("Start a new conversation?");
    expect(dialog.textContent).toContain(
      "Your visible conversation will be cleared. Your training data and saved coach memory will remain.",
    );
    expect((globalThis.document as unknown as FakeDocument).activeElement).toBe(cancel);

    cancel.dispatch("click");
    expect(onCancelNewConversation).toHaveBeenCalledTimes(1);
    mounted.view.render(present);
    expect(dialog.open).toBe(false);
    expect((globalThis.document as unknown as FakeDocument).activeElement).toBe(button);
    expect(textarea.value).toBe("  exact draft  ");

    mounted.view.render(confirming);
    dialog.dispatch("cancel", { preventDefault: vi.fn() });
    expect(onCancelNewConversation).toHaveBeenCalledTimes(2);
    mounted.view.render(present);
    expect((globalThis.document as unknown as FakeDocument).activeElement).toBe(button);
    expect(textarea.value).toBe("  exact draft  ");
  });

  it("marks a pending reset busy and disables every conflicting control", () => {
    const actionHost = new FakeElement("div");
    const thread = new FakeElement("div");
    const composerHost = new FakeElement("div");
    const mounted = mountChatView({
      conversation: new FakeElement("main") as never,
      thread: thread as never,
      composerHost: composerHost as never,
      actionHost: actionHost as never,
    });
    let state = reduceChatState(emptyState, { type: "session-probe", hasSession: true });
    state = reduceChatState(state, { type: "open-new-conversation" });
    state = reduceChatState(state, { type: "begin-reset" });
    mounted.view.render({ ...state, status: "interrupted" });

    const dialog = find(actionHost, (node) => node.tagName === "dialog");
    const dialogButtons = findAll(dialog, (node) => node.tagName === "button");
    const composerControls = findAll(composerHost, (node) =>
      ["textarea", "button"].includes(node.tagName),
    );
    const retry = find(thread, (node) => node.className === "chat-retry");
    expect(dialog.attributes.get("aria-busy")).toBe("true");
    expect(dialogButtons.every((button) => button.disabled)).toBe(true);
    expect(composerControls.every((control) => control.disabled)).toBe(true);
    expect(retry.disabled).toBe(true);
  });

  it.each([
    "New conversation started.",
    "New conversation started. Some recent details may not have been saved to coach memory.",
  ])("clears and focuses the composer only after success announced as %s", (announcement) => {
    const actionHost = new FakeElement("div");
    const composerHost = new FakeElement("div");
    const mounted = mountChatView({
      conversation: new FakeElement("main") as never,
      thread: new FakeElement("div") as never,
      composerHost: composerHost as never,
      actionHost: actionHost as never,
    });
    const textarea = find(composerHost, (node) => node.tagName === "textarea");
    textarea.value = "preserve until success";
    let state = reduceChatState(emptyState, { type: "session-probe", hasSession: true });
    state = reduceChatState(state, { type: "open-new-conversation" });
    state = reduceChatState(state, { type: "begin-reset" });
    mounted.view.render(state);
    expect(textarea.value).toBe("preserve until success");
    expect(textarea.disabled).toBe(true);
    state = reduceChatState(state, { type: "reset-succeeded", announcement });
    mounted.view.render(state);

    const status = find(composerHost, (node) => node.className === "new-conversation-status");
    expect(textarea.value).toBe("");
    expect((globalThis.document as unknown as FakeDocument).activeElement).toBe(textarea);
    expect(status.attributes.get("role")).toBe("status");
    expect(status.attributes.get("aria-live")).toBe("polite");
    expect(status.textContent).toBe(announcement);
  });

  it("keeps one primed status region and mutates it only across announcement changes", () => {
    const composerHost = new FakeElement("div");
    const mounted = mountChatView({
      conversation: new FakeElement("main") as never,
      thread: new FakeElement("div") as never,
      composerHost: composerHost as never,
    });
    const statuses = findAll(composerHost, (node) => node.className === "new-conversation-status");
    const status = statuses[0]!;
    const announcement = "New conversation started.";

    expect(statuses).toHaveLength(1);
    expect(status.attributes.get("role")).toBe("status");
    expect(status.attributes.get("aria-live")).toBe("polite");
    expect(status.hidden).toBe(false);
    expect(status.attributes.has("hidden")).toBe(false);
    expect(status.textContent).toBe("");
    expect(status.textContentMutationCount).toBe(0);

    let state = reduceChatState(emptyState, { type: "session-probe", hasSession: true });
    state = reduceChatState(state, { type: "open-new-conversation" });
    state = reduceChatState(state, { type: "begin-reset" });
    state = reduceChatState(state, { type: "reset-succeeded", announcement });
    mounted.view.render(state);
    expect(status.textContent).toBe(announcement);
    expect(status.textContentMutationCount).toBe(1);

    mounted.view.render(state);
    expect(status.textContentMutationCount).toBe(1);

    state = reduceChatState(state, {
      type: "submit",
      requestKey: 2,
      userMessage: "What should I ride today?",
      userMessageId: "message-3",
      assistantMessageId: "message-4",
      includeUser: true,
    });
    mounted.view.render(state);
    expect(status.textContent).toBe("");
    expect(status.textContentMutationCount).toBe(2);

    state = reduceChatState(state, {
      type: "event",
      requestKey: 2,
      event: { type: "final-text", turnId: "turn-2", text: "Ride easy." },
    });
    state = reduceChatState(state, { type: "complete", requestKey: 2 });
    state = reduceChatState(state, { type: "open-new-conversation" });
    state = reduceChatState(state, { type: "begin-reset" });
    state = reduceChatState(state, { type: "reset-succeeded", announcement });
    mounted.view.render(state);
    expect(status.textContent).toBe(announcement);
    expect(status.textContentMutationCount).toBe(3);
  });

  it("preserves the exact draft and restores the opener after uncertain failure", () => {
    const actionHost = new FakeElement("div");
    const composerHost = new FakeElement("div");
    const mounted = mountChatView({
      conversation: new FakeElement("main") as never,
      thread: new FakeElement("div") as never,
      composerHost: composerHost as never,
      actionHost: actionHost as never,
    });
    const textarea = find(composerHost, (node) => node.tagName === "textarea");
    const button = find(actionHost, (node) => node.className === "new-conversation-button");
    textarea.value = "  exact uncertain draft\n";
    let state = reduceChatState(emptyState, { type: "session-probe", hasSession: true });
    state = reduceChatState(state, { type: "open-new-conversation" });
    state = reduceChatState(state, { type: "begin-reset" });
    mounted.view.render(state);
    state = reduceChatState(state, {
      type: "reset-failed",
      announcement:
        "We couldn’t confirm whether the new conversation started. Your visible conversation is preserved.",
    });
    mounted.view.render(state);

    const status = find(composerHost, (node) => node.className === "new-conversation-status");
    expect(textarea.value).toBe("  exact uncertain draft\n");
    expect((globalThis.document as unknown as FakeDocument).activeElement).toBe(button);
    expect(button.disabled).toBe(false);
    expect(button.attributes.get("aria-disabled")).toBe("true");
    expect(status.textContent).toBe(
      "We couldn’t confirm whether the new conversation started. Your visible conversation is preserved.",
    );
  });

  it("removes new listeners and elements while safely closing an open dialog", () => {
    const actionHost = new FakeElement("div");
    const thread = new FakeElement("div");
    const composerHost = new FakeElement("div");
    const mounted = mountChatView({
      conversation: new FakeElement("main") as never,
      thread: thread as never,
      composerHost: composerHost as never,
      actionHost: actionHost as never,
    });
    const onOpenNewConversation = vi.fn();
    mounted.bind({
      onSubmit: vi.fn(),
      onRetry: vi.fn(),
      onOpenNewConversation,
      onCancelNewConversation: vi.fn(),
      onConfirmNewConversation: vi.fn(),
    });
    const button = find(actionHost, (node) => node.className === "new-conversation-button");
    const dialog = find(actionHost, (node) => node.tagName === "dialog");
    let state = reduceChatState(emptyState, { type: "session-probe", hasSession: true });
    state = reduceChatState(state, { type: "open-new-conversation" });
    mounted.view.render(state);
    expect(dialog.open).toBe(true);

    mounted.dispose();
    button.dispatch("click");
    expect(onOpenNewConversation).not.toHaveBeenCalled();
    expect(dialog.open).toBe(false);
    expect(dialog.removed).toBe(true);
    expect(button.removed).toBe(true);
    expect(find(thread, (node) => node.className === "chat-transcript").removed).toBe(true);
    expect(find(composerHost, (node) => node.className === "composer").removed).toBe(true);
  });
});
