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
  scrollHeight = 0;
  scrollTop = 0;
  clientHeight = 0;
  private ownText = "";

  constructor(readonly tagName: string) {}

  get textContent(): string {
    return this.ownText + this.children.map((child) => child.textContent).join("");
  }

  set textContent(value: string) {
    this.ownText = value;
    this.children.splice(0);
  }

  append(...nodes: Array<FakeElement | string>): void {
    for (const node of nodes) {
      this.children.push(typeof node === "string" ? new FakeElement("#text") : node);
      if (typeof node === "string") this.children.at(-1)!.textContent = node;
    }
  }

  replaceChildren(...nodes: FakeElement[]): void {
    this.ownText = "";
    this.children.splice(0, this.children.length, ...nodes);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
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

  remove(): void {
    this.removed = true;
  }
}

class FakeDocument {
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

const emptyState: ChatState = {
  status: "idle",
  messages: [],
  activeTurn: null,
  progress: null,
};

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
    mounted.bind({ onSubmit, onRetry: vi.fn() });
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
    mounted.bind({ onSubmit: vi.fn(), onRetry });
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
});
