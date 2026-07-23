import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CoachClientCallOptions } from "@enduragent/coach-client";
import type { TurnEvent } from "@enduragent/coach-contract";
import { createChatController } from "../src/chat/controller.js";
import { mountChatView } from "../src/chat/view.js";
import { EMPTY_CHAT_STATE, reduceChatState, type ChatState } from "../src/turn-state.js";

const mutationEvents: string[] = [];

class FakeStyle {
  readonly properties = new Map<string, string>();
  mutationCount = 0;

  setProperty(name: string, value: string): void {
    this.mutationCount += 1;
    this.properties.set(name, value);
  }

  removeProperty(name: string): string {
    this.mutationCount += 1;
    const previous = this.properties.get(name) ?? "";
    this.properties.delete(name);
    return previous;
  }

  getPropertyValue(name: string): string {
    return this.properties.get(name) ?? "";
  }
}

class FakeChildList extends Array<FakeElement> {
  item(index: number): FakeElement | null {
    return this[index] ?? null;
  }
}

class FakeElement {
  readonly children = new FakeChildList();
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Set<(event: never) => void>>();
  readonly dataset: Record<string, string> = {};
  readonly style = new FakeStyle();
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
  insertBeforeMutationCount = 0;
  removeMutationCount = 0;
  appendDataMutationCount = 0;
  focusCount = 0;
  rectHeight = 0;
  parentNode: FakeElement | null = null;
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
    for (const child of this.children) child.parentNode = null;
    this.children.splice(0);
  }

  append(...nodes: Array<FakeElement | string>): void {
    for (const node of nodes) {
      const child = typeof node === "string" ? new FakeElement("#text") : node;
      if (typeof node === "string") child.textContent = node;
      if (child.tagName === "#fragment") {
        this.append(...child.children.splice(0));
        continue;
      }
      child.parentNode?.detach(child);
      child.parentNode = this;
      this.children.push(child);
    }
  }

  appendData(value: string): void {
    this.appendDataMutationCount += 1;
    this.ownText += value;
  }

  insertBefore(node: FakeElement, reference: FakeElement | null): void {
    this.insertBeforeMutationCount += 1;
    node.parentNode?.detach(node);
    const index = reference === null ? -1 : this.children.indexOf(reference);
    node.parentNode = this;
    if (index === -1) this.children.push(node);
    else this.children.splice(index, 0, node);
  }

  replaceChildren(...nodes: FakeElement[]): void {
    this.replaceChildrenMutationCount += 1;
    mutationEvents.push(`${this.className || this.tagName}:replaceChildren`);
    this.ownText = "";
    for (const child of this.children) child.parentNode = null;
    this.children.splice(0);
    this.append(...nodes);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    mutationEvents.push(`${this.className || this.tagName}:removeAttribute:${name}`);
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
    this.focusCount += 1;
    const fakeDocument = globalThis.document as unknown as FakeDocument;
    fakeDocument.activeElement = this;
    fakeDocument.dispatch("focusin", { target: this });
  }

  getBoundingClientRect(): { readonly height: number } {
    return { height: this.rectHeight };
  }

  remove(): void {
    this.removed = true;
    this.removeMutationCount += 1;
    this.parentNode?.detach(this);
  }

  private detach(child: FakeElement): void {
    const index = this.children.indexOf(child);
    if (index !== -1) this.children.splice(index, 1);
    child.parentNode = null;
  }
}

class FakeDocument {
  readonly body = new FakeElement("body");
  readonly documentElement = new FakeElement("html");
  readonly listeners = new Map<string, Set<(event: never) => void>>();
  activeElement: FakeElement | null = null;

  createElement(name: string): FakeElement {
    return new FakeElement(name);
  }

  createTextNode(value: string): FakeElement {
    const node = new FakeElement("#text");
    node.textContent = value;
    return node;
  }

  createDocumentFragment(): FakeElement {
    return new FakeElement("#fragment");
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
}

class FakeResizeObserver {
  static readonly instances: FakeResizeObserver[] = [];

  readonly observed = new Set<unknown>();
  disconnected = false;

  constructor(private readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }

  observe(target: unknown): void {
    this.observed.add(target);
  }

  disconnect(): void {
    this.disconnected = true;
    this.observed.clear();
  }

  notify(): void {
    this.callback([], this as never);
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
  mutationEvents.splice(0);
  FakeResizeObserver.instances.splice(0);
  Object.assign(globalThis, {
    document: new FakeDocument(),
    HTMLElement: FakeElement,
    ResizeObserver: undefined,
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
    expect(
      find(composerHost, (node) => node.tagName === "button" && node.type === "submit").disabled,
    ).toBe(false);
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
    expect(
      find(composerHost, (node) => node.tagName === "button" && node.type === "submit").disabled,
    ).toBe(false);
  });

  it("renders generic failure copy once as a notice without an empty coach row", () => {
    const thread = new FakeElement("div");
    const mounted = mountChatView({
      conversation: new FakeElement("main") as never,
      thread: thread as never,
      composerHost: new FakeElement("div") as never,
    });
    const failureCopy = "The coach couldn't respond. Please try again.";
    const messages = find(thread, (node) => node.className === "chat-messages");
    let state = submittedState();
    mounted.view.render(state);
    const athlete = messages.children[0]!;
    const insertions = messages.insertBeforeMutationCount;
    state = reduceChatState(state, {
      type: "fail",
      requestKey: 1,
      copy: failureCopy,
    });

    mounted.view.render(state);

    expect(occurrences(thread.textContent, failureCopy)).toBe(1);
    expect(messages.children).toEqual([athlete]);
    expect(messages.insertBeforeMutationCount).toBe(insertions);
    expect(messages.textContentMutationCount).toBe(0);
    expect(athlete.removeMutationCount).toBe(0);
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

  it("preserves keyed row identity while updating only changed streaming content", () => {
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
    const athlete = messages.children[0]!;
    const athleteText = find(athlete, (node) => node.className === "chat-message__text");
    expect(messages.replaceChildrenMutationCount).toBe(0);
    expect(messages.textContent).toContain("How should I train?");
    expect(notice.textContentMutationCount).toBe(0);

    state = reduceChatState(state, {
      type: "event",
      requestKey: 1,
      event: { type: "text_delta", turnId: "turn-1", delta: "Partial **coach" },
    });
    mounted.view.render(state);
    const coach = messages.children[1]!;
    const coachText = find(coach, (node) => node.className === "chat-message__text");
    const streamText = coachText.children[0]!;
    const insertedRows = messages.insertBeforeMutationCount;
    expect(messages.replaceChildrenMutationCount).toBe(0);
    expect(messages.children[0]).toBe(athlete);
    expect(find(athlete, (node) => node.className === "chat-message__text")).toBe(athleteText);
    expect(messages.textContent).toContain("Partial **coach");
    expect(findAll(coach, (node) => node.tagName === "strong")).toHaveLength(0);
    expect(coach.attributes.get("aria-busy")).toBe("true");
    expect(notice.textContentMutationCount).toBe(0);

    state = reduceChatState(state, {
      type: "event",
      requestKey: 1,
      event: { type: "text_delta", turnId: "turn-1", delta: " draft**" },
    });
    mounted.view.render(state, {
      newConversationDisabled: true,
      workBlocked: false,
      appendDelta: {
        messageId: "message-2",
        previousTextLength: "Partial **coach".length,
        nextTextLength: "Partial **coach draft**".length,
        delta: " draft**",
      },
    });
    expect(coachText.children[0]).toBe(streamText);
    expect(streamText.appendDataMutationCount).toBe(1);
    expect(coachText.textContent).toBe("Partial **coach draft**");
    expect(findAll(coach, (node) => node.tagName === "strong")).toHaveLength(0);
    expect(messages.insertBeforeMutationCount).toBe(insertedRows);
    expect(athlete.removeMutationCount).toBe(0);
    expect(coach.removeMutationCount).toBe(0);

    mounted.view.render({
      ...state,
      progress: "Checking your training data…",
      messages: state.messages.map((message) => ({ ...message })),
    });
    expect(messages.children[0]).toBe(athlete);
    expect(messages.children[1]).toBe(coach);
    expect(coachText.children[0]).toBe(streamText);
    expect(messages.insertBeforeMutationCount).toBe(insertedRows);

    state = reduceChatState(state, {
      type: "event",
      requestKey: 1,
      event: { type: "final-text", turnId: "turn-1", text: "Partial **coach draft**" },
    });
    mounted.view.render(state);
    expect(messages.children[1]).toBe(coach);
    expect(coachText.children[0]).toBe(streamText);
    expect(coachText.replaceChildrenMutationCount).toBe(0);
    expect(coach.attributes.get("aria-busy")).toBe("true");
    expect(messages.insertBeforeMutationCount).toBe(insertedRows);

    state = reduceChatState(state, { type: "complete", requestKey: 1 });
    mounted.view.render(state);
    expect(messages.children[0]).toBe(athlete);
    expect(messages.children[1]).toBe(coach);
    expect(coachText.replaceChildrenMutationCount).toBe(1);
    expect(findAll(coach, (node) => node.tagName === "strong")[0]?.textContent).toBe("coach draft");
    expect(coach.attributes.has("aria-busy")).toBe(false);
    expect(coach.attributes.get("aria-atomic")).toBe("true");
    expect(coach.attributes.has("aria-live")).toBe(false);
    expect(athlete.attributes.get("aria-live")).toBe("off");
    expect(messages.insertBeforeMutationCount).toBe(insertedRows);
    expect(athlete.removeMutationCount).toBe(0);
    expect(coach.removeMutationCount).toBe(0);

    mounted.view.render(state, { newConversationDisabled: true, workBlocked: false });
    expect(messages.children[0]).toBe(athlete);
    expect(messages.children[1]).toBe(coach);
    expect(coachText.replaceChildrenMutationCount).toBe(1);
    expect(messages.insertBeforeMutationCount).toBe(insertedRows);
  });

  it("reconciles final coach content before clearing its busy state", () => {
    const thread = new FakeElement("div");
    const mounted = mountChatView({
      conversation: new FakeElement("main") as never,
      thread: thread as never,
      composerHost: new FakeElement("div") as never,
    });
    let state = submittedState();
    state = reduceChatState(state, {
      type: "event",
      requestKey: 1,
      event: { type: "text_delta", turnId: "turn-1", delta: "Draft" },
    });
    mounted.view.render(state);
    state = reduceChatState(state, {
      type: "event",
      requestKey: 1,
      event: { type: "final-text", turnId: "turn-1", text: "Final **answer**" },
    });
    state = reduceChatState(state, { type: "complete", requestKey: 1 });
    mutationEvents.splice(0);

    mounted.view.render(state);

    expect(mutationEvents.filter((event) => event.startsWith("chat-message"))).toEqual([
      "chat-message__text:replaceChildren",
      "chat-message chat-message--coach:removeAttribute:aria-busy",
    ]);
    const coach = find(thread, (node) => node.className.includes("chat-message--coach"));
    expect(findAll(coach, (node) => node.tagName === "strong")[0]?.textContent).toBe("answer");
  });

  it("replaces a corrected final while busy and parses it only on completion", () => {
    const thread = new FakeElement("div");
    const mounted = mountChatView({
      conversation: new FakeElement("main") as never,
      thread: thread as never,
      composerHost: new FakeElement("div") as never,
    });
    let state = submittedState();
    state = reduceChatState(state, {
      type: "event",
      requestKey: 1,
      event: { type: "text_delta", turnId: "turn-1", delta: "Draft" },
    });
    mounted.view.render(state);
    const messages = find(thread, (node) => node.className === "chat-messages");
    const coach = messages.children[1]!;
    const coachText = find(coach, (node) => node.className === "chat-message__text");
    const draftNode = coachText.children[0]!;
    const insertions = messages.insertBeforeMutationCount;

    state = reduceChatState(state, {
      type: "event",
      requestKey: 1,
      event: { type: "final-text", turnId: "turn-1", text: "Corrected **answer**" },
    });
    mounted.view.render(state);

    expect(coachText.children[0]).not.toBe(draftNode);
    expect(coachText.textContent).toBe("Corrected **answer**");
    expect(findAll(coach, (node) => node.tagName === "strong")).toHaveLength(0);
    expect(coach.attributes.get("aria-busy")).toBe("true");
    expect(messages.insertBeforeMutationCount).toBe(insertions);

    state = reduceChatState(state, { type: "complete", requestKey: 1 });
    mounted.view.render(state);

    expect(findAll(coach, (node) => node.tagName === "strong")[0]?.textContent).toBe("answer");
    expect(coach.attributes.has("aria-busy")).toBe(false);
    expect(messages.insertBeforeMutationCount).toBe(insertions);
    expect(coach.removeMutationCount).toBe(0);
  });

  it("keeps transcript rows stable when controller background cleanup releases a turn", async () => {
    const thread = new FakeElement("div");
    const mounted = mountChatView({
      conversation: new FakeElement("main") as never,
      thread: thread as never,
      composerHost: new FakeElement("div") as never,
    });
    let releaseTrainingRefresh: (() => void) | undefined;
    const trainingRefresh = new Promise<void>((resolve) => {
      releaseTrainingRefresh = resolve;
    });
    const finalText = "Final **answer**";
    const call = vi.fn(
      async (
        method: string,
        _request: unknown,
        options: CoachClientCallOptions<"chat"> | undefined,
      ) => {
        if (method !== "chat") throw new TypeError();
        const deliver = (event: TurnEvent): void => {
          options?.onNotificationEnvelope?.({
            jsonrpc: "2.0",
            method: "coach.turnEvent",
            params: {
              requestId: 1,
              requestMethod: "chat",
              turnId: event.turnId,
              event,
            },
          });
          options?.onEvent?.(event);
        };
        deliver({ type: "text_delta", turnId: "turn-1", delta: "Final **ans" });
        deliver({ type: "text_delta", turnId: "turn-1", delta: "wer**" });
        deliver({ type: "final-text", turnId: "turn-1", text: finalText });
        options?.onTerminalEnvelope?.({
          jsonrpc: "2.0",
          id: 1,
          result: { text: finalText },
        });
        return { text: finalText };
      },
    );
    const fakeClient = { handshake: {}, call, close: vi.fn(async () => {}) };
    const controller = createChatController({
      clients: {
        getClient: vi.fn(async () => fakeClient as never),
        reconnect: vi.fn(async () => fakeClient as never),
        close: vi.fn(async () => {}),
      },
      view: mounted.view,
      refreshTrainingContext: () => trainingRefresh,
      refreshSpend: async () => {},
    });

    const submission = controller.submit("How should I train?");
    const messages = find(thread, (node) => node.className === "chat-messages");
    await vi.waitFor(() => {
      expect(messages.children).toHaveLength(2);
      expect(messages.children[1]?.attributes.has("aria-busy")).toBe(false);
    });
    const athlete = messages.children[0]!;
    const coach = messages.children[1]!;
    const insertions = messages.insertBeforeMutationCount;
    const athleteRemovals = athlete.removeMutationCount;
    const coachRemovals = coach.removeMutationCount;
    const coachText = find(coach, (node) => node.className === "chat-message__text");
    const replacements = coachText.replaceChildrenMutationCount;

    releaseTrainingRefresh?.();
    await submission;
    await Promise.resolve();

    expect(messages.children[0]).toBe(athlete);
    expect(messages.children[1]).toBe(coach);
    expect(messages.insertBeforeMutationCount).toBe(insertions);
    expect(athlete.removeMutationCount).toBe(athleteRemovals);
    expect(coach.removeMutationCount).toBe(coachRemovals);
    expect(coachText.replaceChildrenMutationCount).toBe(replacements);
    expect(findAll(coach, (node) => node.tagName === "strong")[0]?.textContent).toBe("answer");
  });

  it("keeps one streaming text node across many controller-delivered tiny deltas", async () => {
    const thread = new FakeElement("div");
    const mounted = mountChatView({
      conversation: new FakeElement("main") as never,
      thread: thread as never,
      composerHost: new FakeElement("div") as never,
    });
    let finishTurn: (() => void) | undefined;
    const finishGate = new Promise<void>((resolve) => {
      finishTurn = resolve;
    });
    let markStreamingDelivered: (() => void) | undefined;
    const streamingDelivered = new Promise<void>((resolve) => {
      markStreamingDelivered = resolve;
    });
    const finalText = `Line  one\n**steady** ${"x".repeat(256)}`;
    const call = vi.fn(
      async (
        method: string,
        _request: unknown,
        options: CoachClientCallOptions<"chat"> | undefined,
      ) => {
        if (method !== "chat") throw new TypeError();
        const deliver = (event: TurnEvent): void => {
          options?.onNotificationEnvelope?.({
            jsonrpc: "2.0",
            method: "coach.turnEvent",
            params: {
              requestId: 1,
              requestMethod: "chat",
              turnId: event.turnId,
              event,
            },
          });
          options?.onEvent?.(event);
        };
        for (let index = 0; index < finalText.length; index += 1) {
          deliver({ type: "text_delta", turnId: "turn-1", delta: finalText[index]! });
        }
        markStreamingDelivered?.();
        await finishGate;
        deliver({ type: "final-text", turnId: "turn-1", text: finalText });
        options?.onTerminalEnvelope?.({
          jsonrpc: "2.0",
          id: 1,
          result: { text: finalText },
        });
        return { text: finalText };
      },
    );
    const fakeClient = { handshake: {}, call, close: vi.fn(async () => {}) };
    const controller = createChatController({
      clients: {
        getClient: vi.fn(async () => fakeClient as never),
        reconnect: vi.fn(async () => fakeClient as never),
        close: vi.fn(async () => {}),
      },
      view: mounted.view,
      refreshTrainingContext: async () => {},
      refreshSpend: async () => {},
    });

    const submission = controller.submit("How should I train?");
    await streamingDelivered;
    const messages = find(thread, (node) => node.className === "chat-messages");
    const athlete = messages.children[0]!;
    const coach = messages.children[1]!;
    const coachText = find(coach, (node) => node.className === "chat-message__text");
    const streamNode = coachText.children[0]!;
    const insertions = messages.insertBeforeMutationCount;

    expect(coachText.children).toEqual([streamNode]);
    expect(streamNode.textContent).toBe(finalText);
    expect(streamNode.appendDataMutationCount).toBe(finalText.length - 1);
    expect(coachText.replaceChildrenMutationCount).toBe(0);
    expect(messages.insertBeforeMutationCount).toBe(2);
    expect(athlete.removeMutationCount).toBe(0);
    expect(coach.removeMutationCount).toBe(0);

    finishTurn?.();
    await submission;

    expect(messages.children[0]).toBe(athlete);
    expect(messages.children[1]).toBe(coach);
    expect(messages.insertBeforeMutationCount).toBe(insertions);
    expect(findAll(coach, (node) => node.tagName === "strong")[0]?.textContent).toBe("steady");
  });

  it("treats changed message ids as new row identities even when semantics match", () => {
    const thread = new FakeElement("div");
    const mounted = mountChatView({
      conversation: new FakeElement("main") as never,
      thread: thread as never,
      composerHost: new FakeElement("div") as never,
    });
    const messages = find(thread, (node) => node.className === "chat-messages");
    const state = submittedState();
    mounted.view.render(state);
    const original = messages.children[0]!;

    mounted.view.render({
      ...state,
      messages: state.messages.map((message) => ({ ...message, id: `${message.id}-changed` })),
    });

    expect(messages.children[0]).not.toBe(original);
    expect(original.removed).toBe(true);
    expect(messages.textContent).toContain("How should I train?");
    expect(messages.replaceChildrenMutationCount).toBe(0);
  });

  it("rejects duplicate message ids before mutating any transcript node", () => {
    const thread = new FakeElement("div");
    const actionHost = new FakeElement("div");
    const mounted = mountChatView({
      conversation: new FakeElement("main") as never,
      thread: thread as never,
      composerHost: new FakeElement("div") as never,
      actionHost: actionHost as never,
    });
    const messages = find(thread, (node) => node.className === "chat-messages");
    const state = submittedState();
    mounted.view.render(state);
    const athlete = messages.children[0]!;
    const insertions = messages.insertBeforeMutationCount;
    const opener = find(actionHost, (node) => node.className === "new-conversation-button");
    const openerDisabled = opener.disabled;

    expect(() =>
      mounted.view.render({
        ...state,
        session: { ...state.session, presence: "present" },
        messages: state.messages.map((message) => ({ ...message, id: "duplicate" })),
      }),
    ).toThrow("duplicate chat message id");

    expect(messages.children).toEqual([athlete]);
    expect(messages.insertBeforeMutationCount).toBe(insertions);
    expect(messages.textContentMutationCount).toBe(0);
    expect(athlete.removeMutationCount).toBe(0);
    expect(opener.disabled).toBe(openerDisabled);
  });

  it("preserves interrupted history when retry adds a newly keyed coach row", () => {
    const thread = new FakeElement("div");
    const mounted = mountChatView({
      conversation: new FakeElement("main") as never,
      thread: thread as never,
      composerHost: new FakeElement("div") as never,
    });
    const messages = find(thread, (node) => node.className === "chat-messages");
    let state = submittedState();
    state = reduceChatState(state, {
      type: "event",
      requestKey: 1,
      event: { type: "text_delta", turnId: "turn-1", delta: "**Preserved partial**" },
    });
    mounted.view.render(state);
    const athlete = messages.children[0]!;
    const interrupted = messages.children[1]!;
    const insertionsBeforeInterruption = messages.insertBeforeMutationCount;
    expect(interrupted.attributes.get("aria-busy")).toBe("true");
    expect(findAll(interrupted, (node) => node.tagName === "strong")).toHaveLength(0);

    state = reduceChatState(state, {
      type: "interrupt",
      requestKey: 1,
      copy: "Connection interrupted. Your partial response is preserved.",
    });
    mounted.view.render(state);
    expect(interrupted.attributes.has("aria-busy")).toBe(false);
    expect(findAll(interrupted, (node) => node.tagName === "strong")[0]?.textContent).toBe(
      "Preserved partial",
    );
    expect(messages.insertBeforeMutationCount).toBe(insertionsBeforeInterruption);
    expect(athlete.removeMutationCount).toBe(0);
    expect(interrupted.removeMutationCount).toBe(0);

    state = reduceChatState(state, {
      type: "submit",
      requestKey: 2,
      userMessage: "How should I train?",
      userMessageId: "unused-message",
      assistantMessageId: "message-3",
      includeUser: false,
    });
    state = reduceChatState(state, {
      type: "event",
      requestKey: 2,
      event: { type: "text_delta", turnId: "turn-2", delta: "Fresh retry" },
    });
    mounted.view.render(state);

    expect(messages.children).toHaveLength(3);
    expect(messages.children[0]).toBe(athlete);
    expect(messages.children[1]).toBe(interrupted);
    expect(messages.children[2]).not.toBe(interrupted);
    expect(messages.children[2]?.textContent).toContain("Fresh retry");
    expect(interrupted.textContent).toContain("Preserved partial");
    expect(messages.insertBeforeMutationCount).toBe(insertionsBeforeInterruption + 1);
    expect(athlete.removeMutationCount).toBe(0);
    expect(interrupted.removeMutationCount).toBe(0);
  });

  it("keeps rows stable through reset controls and clears the transcript exactly once on success", () => {
    const thread = new FakeElement("div");
    const mounted = mountChatView({
      conversation: new FakeElement("main") as never,
      thread: thread as never,
      composerHost: new FakeElement("div") as never,
      actionHost: new FakeElement("div") as never,
    });
    const messages = find(thread, (node) => node.className === "chat-messages");
    let state = submittedState();
    state = reduceChatState(state, {
      type: "event",
      requestKey: 1,
      event: { type: "final-text", turnId: "turn-1", text: "Ride easy." },
    });
    state = reduceChatState(state, { type: "complete", requestKey: 1 });
    mounted.view.render(state);
    const athlete = messages.children[0]!;
    const coach = messages.children[1]!;
    const insertions = messages.insertBeforeMutationCount;
    const expectNoStructuralMutation = (): void => {
      expect(messages.insertBeforeMutationCount).toBe(insertions);
      expect(messages.textContentMutationCount).toBe(0);
      expect(athlete.removeMutationCount).toBe(0);
      expect(coach.removeMutationCount).toBe(0);
    };

    let resetState = reduceChatState(state, { type: "open-new-conversation" });
    mounted.view.render(resetState);
    expect(messages.children[0]).toBe(athlete);
    expect(messages.children[1]).toBe(coach);
    expectNoStructuralMutation();
    resetState = reduceChatState(resetState, { type: "cancel-new-conversation" });
    mounted.view.render(resetState);
    expect(messages.children[0]).toBe(athlete);
    expect(messages.children[1]).toBe(coach);
    expectNoStructuralMutation();
    resetState = reduceChatState(resetState, { type: "open-new-conversation" });
    resetState = reduceChatState(resetState, { type: "begin-reset" });
    mounted.view.render(resetState, { newConversationDisabled: true, workBlocked: true });
    expect(messages.children[0]).toBe(athlete);
    expect(messages.children[1]).toBe(coach);
    expectNoStructuralMutation();

    const failedState = reduceChatState(resetState, {
      type: "reset-failed",
      announcement: "Reset could not be confirmed.",
    });
    mounted.view.render(failedState);
    expect(messages.children[0]).toBe(athlete);
    expect(messages.children[1]).toBe(coach);
    expectNoStructuralMutation();

    resetState = reduceChatState(state, { type: "open-new-conversation" });
    resetState = reduceChatState(resetState, { type: "begin-reset" });
    mounted.view.render(resetState);
    expectNoStructuralMutation();

    const clearedState = reduceChatState(resetState, {
      type: "reset-succeeded",
      announcement: "New conversation started.",
    });
    mounted.view.render(clearedState);
    expect(messages.textContentMutationCount).toBe(1);
    expect(messages.children).toHaveLength(0);
    expect(messages.insertBeforeMutationCount).toBe(insertions);
    expect(athlete.removeMutationCount).toBe(0);
    expect(coach.removeMutationCount).toBe(0);
    mounted.view.render(clearedState, { newConversationDisabled: true, workBlocked: false });
    expect(messages.textContentMutationCount).toBe(1);
    expect(messages.replaceChildrenMutationCount).toBe(0);
  });

  it("places one notice host and one shortcut group before the composer", () => {
    const composerHost = new FakeElement("div");
    const mounted = mountChatView({
      conversation: new FakeElement("main") as never,
      thread: new FakeElement("div") as never,
      composerHost: composerHost as never,
    });
    const host = mounted.noticeHost as unknown as FakeElement;
    expect(host.className).toBe("chat-notice-host");
    expect(composerHost.children[0]).toBe(host);
    expect(composerHost.children[1]?.className).toBe("coaching-shortcuts");
    expect(composerHost.children[2]?.className).toBe("composer");
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
    expect(findAll(thread, (node) => node.tagName === "img")).toHaveLength(0);
    const transcript = find(thread, (node) => node.className === "chat-transcript");
    expect(transcript.attributes.get("role")).toBe("log");
    expect(transcript.attributes.get("aria-live")).toBe("polite");
    expect(transcript.attributes.get("aria-relevant")).toBe("additions text");
    expect(transcript.attributes.get("aria-atomic")).toBe("false");
  });

  it("renders semantic Markdown only for coach rows", () => {
    const thread = new FakeElement("div");
    const mounted = mountChatView({
      conversation: new FakeElement("main") as never,
      thread: thread as never,
      composerHost: new FakeElement("div") as never,
    });
    mounted.view.render({
      ...emptyState,
      messages: [
        {
          id: "message-1",
          role: "athlete",
          text: "**literal athlete**",
          delivery: "complete",
        },
        {
          id: "message-2",
          role: "coach",
          text: "**formatted coach** [guide](https://example.test/guide)",
          delivery: "complete",
        },
      ],
    });

    const athlete = find(thread, (node) => node.className.includes("chat-message--athlete"));
    const coach = find(thread, (node) => node.className.includes("chat-message--coach"));
    expect(findAll(athlete, (node) => node.tagName === "strong")).toHaveLength(0);
    expect(athlete.textContent).toContain("**literal athlete**");
    expect(findAll(coach, (node) => node.tagName === "strong")[0]?.textContent).toBe(
      "formatted coach",
    );
    expect(findAll(coach, (node) => node.tagName === "a")[0]?.attributes.get("target")).toBe(
      "_blank",
    );
  });

  it("keeps a visible label, submits manual text byte-for-byte, and disables while streaming", () => {
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
    textarea.value = "\t/review deep\r\n";
    form.dispatch("submit", { preventDefault() {} });
    textarea.value = "  /unknown exact\n";
    form.dispatch("submit", { preventDefault() {} });
    expect(onSubmit.mock.calls.map(([message]) => message)).toEqual([
      "  Keep spacing  ",
      "\t/review deep\r\n",
      "  /unknown exact\n",
    ]);
    mounted.view.render({ ...emptyState, status: "streaming" });
    const button = find(
      composerHost,
      (node) => node.tagName === "button" && node.type === "submit",
    );
    expect(textarea.disabled).toBe(true);
    expect(button.disabled).toBe(true);
  });

  it("mounts four unique coaching shortcuts in exact order and preserves the draft", () => {
    const composerHost = new FakeElement("div");
    const mounted = mountChatView({
      conversation: new FakeElement("main") as never,
      thread: new FakeElement("div") as never,
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
    mounted.view.render(emptyState);

    const group = find(composerHost, (node) => node.className === "coaching-shortcuts");
    const buttons = findAll(group, (node) => node.className === "coaching-shortcut");
    const textarea = find(composerHost, (node) => node.tagName === "textarea");
    const labels = buttons.map(
      (button) => find(button, (node) => node.className === "coaching-shortcut__label").textContent,
    );
    const commands = buttons.map(
      (button) =>
        find(button, (node) => node.className === "coaching-shortcut__command").textContent,
    );

    expect(group.attributes.get("role")).toBe("group");
    expect(group.attributes.get("aria-label")).toBe("Coaching shortcuts");
    expect(buttons).toHaveLength(4);
    expect(labels).toEqual([
      "Build a plan",
      "Today’s workout",
      "Training status",
      "Review last session",
    ]);
    expect(commands).toEqual(["/plan", "/workout", "/status", "/review"]);
    expect(new Set(commands)).toHaveProperty("size", 4);
    expect(buttons.map((button) => button.type)).toEqual(["button", "button", "button", "button"]);
    expect(buttons.map((button) => button.attributes.get("aria-label"))).toEqual([
      "Build a plan, /plan command",
      "Today’s workout, /workout command",
      "Training status, /status command",
      "Review last session, /review command",
    ]);

    textarea.value = "  draft\r\nbyte-for-byte  ";
    for (const button of buttons) button.dispatch("click");
    expect(onSubmit.mock.calls.map(([message]) => message)).toEqual(commands);
    expect(textarea.value).toBe("  draft\r\nbyte-for-byte  ");
  });

  it("guards every shortcut while streaming or resetting and re-enables them with the composer", () => {
    const composerHost = new FakeElement("div");
    const mounted = mountChatView({
      conversation: new FakeElement("main") as never,
      thread: new FakeElement("div") as never,
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
    const buttons = findAll(
      find(composerHost, (node) => node.className === "coaching-shortcuts"),
      (node) => node.className === "coaching-shortcut",
    );
    const submit = find(
      composerHost,
      (node) => node.tagName === "button" && node.type === "submit",
    );
    const textarea = find(composerHost, (node) => node.tagName === "textarea");
    const present = reduceChatState(emptyState, { type: "session-probe", hasSession: true });
    const confirming = reduceChatState(present, { type: "open-new-conversation" });
    const resetting = reduceChatState(confirming, { type: "begin-reset" });

    mounted.view.render({ ...present, status: "streaming" });
    expect([...buttons, submit, textarea].every((control) => control.disabled)).toBe(true);
    for (const button of buttons) button.dispatch("click");
    expect(onSubmit).not.toHaveBeenCalled();

    mounted.view.render(confirming);
    expect(buttons.every((button) => button.disabled)).toBe(true);
    for (const button of buttons) button.dispatch("click");
    expect(onSubmit).not.toHaveBeenCalled();

    mounted.view.render(resetting);
    expect(buttons.every((button) => button.disabled)).toBe(true);
    for (const button of buttons) button.dispatch("click");
    expect(onSubmit).not.toHaveBeenCalled();

    mounted.view.render(present);
    expect([...buttons, submit, textarea].every((control) => !control.disabled)).toBe(true);
    buttons[2]?.dispatch("click");
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onSubmit).toHaveBeenCalledWith("/status");
  });

  it("keeps shortcut nodes and their single listeners resident across repeated renders", () => {
    const composerHost = new FakeElement("div");
    const mounted = mountChatView({
      conversation: new FakeElement("main") as never,
      thread: new FakeElement("div") as never,
      composerHost: composerHost as never,
    });
    const group = find(composerHost, (node) => node.className === "coaching-shortcuts");
    const buttons = findAll(group, (node) => node.className === "coaching-shortcut");
    const listeners = buttons.map((button) => [...(button.listeners.get("click") ?? [])][0]);

    for (let index = 0; index < 8; index += 1) {
      mounted.view.render({ ...emptyState, status: index % 2 === 0 ? "idle" : "streaming" });
    }

    expect(find(composerHost, (node) => node.className === "coaching-shortcuts")).toBe(group);
    expect(findAll(composerHost, (node) => node.className === "coaching-shortcuts")).toHaveLength(
      1,
    );
    expect(findAll(group, (node) => node.className === "coaching-shortcut")).toEqual(buttons);
    expect(buttons.map((button) => button.listeners.get("click")?.size)).toEqual([1, 1, 1, 1]);
    expect(buttons.map((button) => [...(button.listeners.get("click") ?? [])][0])).toEqual(
      listeners,
    );
  });

  it("restores keyboard-owned focus to the same shortcut after its turn unlocks", () => {
    const fakeDocument = globalThis.document as unknown as FakeDocument;
    const composerHost = new FakeElement("div");
    const mounted = mountChatView({
      conversation: new FakeElement("main") as never,
      thread: new FakeElement("div") as never,
      composerHost: composerHost as never,
    });
    mounted.bind({
      onSubmit: () => mounted.view.render({ ...emptyState, status: "streaming" }),
      onRetry: vi.fn(),
      onOpenNewConversation: vi.fn(),
      onCancelNewConversation: vi.fn(),
      onConfirmNewConversation: vi.fn(),
    });
    mounted.view.render(emptyState);
    const shortcut = find(
      composerHost,
      (node) => node.className === "coaching-shortcut" && node.textContent.includes("/workout"),
    );

    shortcut.focus();
    shortcut.dispatch("click", { detail: 0 });
    expect(shortcut.disabled).toBe(true);
    fakeDocument.activeElement = fakeDocument.body;

    mounted.view.render(emptyState);

    expect(fakeDocument.activeElement).toBe(shortcut);
    expect(shortcut.focusCount).toBe(2);
  });

  it("does not restore shortcut focus after pointer activation", () => {
    const fakeDocument = globalThis.document as unknown as FakeDocument;
    const composerHost = new FakeElement("div");
    const mounted = mountChatView({
      conversation: new FakeElement("main") as never,
      thread: new FakeElement("div") as never,
      composerHost: composerHost as never,
    });
    mounted.bind({
      onSubmit: () => mounted.view.render({ ...emptyState, status: "streaming" }),
      onRetry: vi.fn(),
      onOpenNewConversation: vi.fn(),
      onCancelNewConversation: vi.fn(),
      onConfirmNewConversation: vi.fn(),
    });
    mounted.view.render(emptyState);
    const shortcut = find(composerHost, (node) => node.className === "coaching-shortcut");

    shortcut.focus();
    shortcut.dispatch("click", { detail: 1 });
    fakeDocument.activeElement = fakeDocument.body;
    mounted.view.render(emptyState);

    expect(fakeDocument.activeElement).toBe(fakeDocument.body);
    expect(shortcut.focusCount).toBe(1);
  });

  it("abandons keyboard focus restoration when focus deliberately moves elsewhere", () => {
    const fakeDocument = globalThis.document as unknown as FakeDocument;
    const composerHost = new FakeElement("div");
    const mounted = mountChatView({
      conversation: new FakeElement("main") as never,
      thread: new FakeElement("div") as never,
      composerHost: composerHost as never,
    });
    mounted.bind({
      onSubmit: () => mounted.view.render({ ...emptyState, status: "streaming" }),
      onRetry: vi.fn(),
      onOpenNewConversation: vi.fn(),
      onCancelNewConversation: vi.fn(),
      onConfirmNewConversation: vi.fn(),
    });
    mounted.view.render(emptyState);
    const shortcut = find(composerHost, (node) => node.className === "coaching-shortcut");
    const otherControl = new FakeElement("button");

    shortcut.focus();
    shortcut.dispatch("click", { detail: 0 });
    fakeDocument.activeElement = fakeDocument.body;
    otherControl.focus();
    mounted.view.render(emptyState);

    expect(fakeDocument.activeElement).toBe(otherControl);
    expect(shortcut.focusCount).toBe(1);

    shortcut.focus();
    shortcut.dispatch("click", { detail: 0 });
    fakeDocument.activeElement = fakeDocument.body;
    otherControl.focus();
    fakeDocument.activeElement = fakeDocument.body;
    mounted.view.render(emptyState);

    expect(fakeDocument.activeElement).toBe(fakeDocument.body);
    expect(shortcut.focusCount).toBe(2);
  });

  it("abandons keyboard focus restoration when reset begins", () => {
    const fakeDocument = globalThis.document as unknown as FakeDocument;
    const composerHost = new FakeElement("div");
    const mounted = mountChatView({
      conversation: new FakeElement("main") as never,
      thread: new FakeElement("div") as never,
      composerHost: composerHost as never,
    });
    const present = reduceChatState(emptyState, { type: "session-probe", hasSession: true });
    const confirming = reduceChatState(present, { type: "open-new-conversation" });
    mounted.bind({
      onSubmit: () => mounted.view.render({ ...present, status: "streaming" }),
      onRetry: vi.fn(),
      onOpenNewConversation: vi.fn(),
      onCancelNewConversation: vi.fn(),
      onConfirmNewConversation: vi.fn(),
    });
    mounted.view.render(present);
    const shortcut = find(composerHost, (node) => node.className === "coaching-shortcut");

    shortcut.focus();
    shortcut.dispatch("click", { detail: 0 });
    fakeDocument.activeElement = fakeDocument.body;
    mounted.view.render(confirming);
    mounted.view.render(present);

    expect(fakeDocument.activeElement).not.toBe(shortcut);
    expect(shortcut.focusCount).toBe(1);
  });

  it("does not restore shortcut focus after disposal", () => {
    const fakeDocument = globalThis.document as unknown as FakeDocument;
    const composerHost = new FakeElement("div");
    const mounted = mountChatView({
      conversation: new FakeElement("main") as never,
      thread: new FakeElement("div") as never,
      composerHost: composerHost as never,
    });
    mounted.bind({
      onSubmit: () => mounted.view.render({ ...emptyState, status: "streaming" }),
      onRetry: vi.fn(),
      onOpenNewConversation: vi.fn(),
      onCancelNewConversation: vi.fn(),
      onConfirmNewConversation: vi.fn(),
    });
    mounted.view.render(emptyState);
    const shortcut = find(composerHost, (node) => node.className === "coaching-shortcut");

    shortcut.focus();
    shortcut.dispatch("click", { detail: 0 });
    fakeDocument.activeElement = fakeDocument.body;
    mounted.dispose();
    mounted.view.render(emptyState);

    expect(fakeDocument.activeElement).toBe(fakeDocument.body);
    expect(shortcut.focusCount).toBe(1);
    expect(fakeDocument.listeners.get("focusin")?.size).toBe(0);
  });

  it("measures composer clearance, follows resize, and stops updates after disposal", () => {
    Object.assign(globalThis, { ResizeObserver: FakeResizeObserver });
    const conversation = new FakeElement("main");
    const composerHost = new FakeElement("div");
    composerHost.rectHeight = 148;

    const mounted = mountChatView({
      conversation: conversation as never,
      thread: new FakeElement("div") as never,
      composerHost: composerHost as never,
    });
    const observer = FakeResizeObserver.instances[0]!;

    expect(FakeResizeObserver.instances).toHaveLength(1);
    expect(observer.observed.has(composerHost)).toBe(true);
    expect(conversation.style.getPropertyValue("--chat-composer-clearance")).toBe("148px");

    composerHost.rectHeight = 226;
    observer.notify();
    expect(conversation.style.getPropertyValue("--chat-composer-clearance")).toBe("226px");

    mounted.dispose();
    expect(observer.disconnected).toBe(true);
    expect(conversation.style.getPropertyValue("--chat-composer-clearance")).toBe("");
    const mutationsAfterDisposal = conversation.style.mutationCount;

    composerHost.rectHeight = 310;
    observer.notify();
    expect(conversation.style.mutationCount).toBe(mutationsAfterDisposal);
    expect(conversation.style.getPropertyValue("--chat-composer-clearance")).toBe("");
  });

  it("admits one paid turn before rapid shortcut and Enter repetitions", async () => {
    const composerHost = new FakeElement("div");
    const mounted = mountChatView({
      conversation: new FakeElement("main") as never,
      thread: new FakeElement("div") as never,
      composerHost: composerHost as never,
    });
    let releaseTurn: (() => void) | undefined;
    const turnGate = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const call = vi.fn(
      async (
        method: string,
        _request: unknown,
        options: CoachClientCallOptions<"chat"> | undefined,
      ) => {
        if (method !== "chat") throw new TypeError();
        await turnGate;
        const event: TurnEvent = { type: "final-text", turnId: "turn-1", text: "Ready." };
        options?.onNotificationEnvelope?.({
          jsonrpc: "2.0",
          method: "coach.turnEvent",
          params: {
            requestId: 1,
            requestMethod: "chat",
            turnId: event.turnId,
            event,
          },
        });
        options?.onEvent?.(event);
        options?.onTerminalEnvelope?.({
          jsonrpc: "2.0",
          id: 1,
          result: { text: event.text },
        });
        return { text: event.text };
      },
    );
    const fakeClient = { handshake: {}, call, close: vi.fn(async () => {}) };
    const controller = createChatController({
      clients: {
        getClient: vi.fn(async () => fakeClient as never),
        reconnect: vi.fn(async () => fakeClient as never),
        close: vi.fn(async () => {}),
      },
      view: mounted.view,
      refreshTrainingContext: async () => {},
      refreshSpend: async () => {},
    });
    mounted.bind({
      onSubmit: (message) => void controller.submit(message),
      onRetry: vi.fn(),
      onOpenNewConversation: vi.fn(),
      onCancelNewConversation: vi.fn(),
      onConfirmNewConversation: vi.fn(),
    });
    const shortcuts = findAll(
      find(composerHost, (node) => node.className === "coaching-shortcuts"),
      (node) => node.className === "coaching-shortcut",
    );
    const plan = shortcuts[0]!;
    const textarea = find(composerHost, (node) => node.tagName === "textarea");
    const submit = find(
      composerHost,
      (node) => node.tagName === "button" && node.type === "submit",
    );
    textarea.value = "keep this draft";

    plan.dispatch("click");
    expect(shortcuts.every((button) => button.disabled)).toBe(true);
    expect(submit.disabled).toBe(true);
    plan.dispatch("click");
    textarea.dispatch("keydown", {
      key: "Enter",
      shiftKey: false,
      preventDefault: vi.fn(),
    });

    await vi.waitFor(() => expect(call).toHaveBeenCalledOnce());
    expect(call.mock.calls[0]?.[1]).toEqual({ chatId: "desktop", message: "/plan" });
    expect(textarea.value).toBe("keep this draft");
    releaseTurn?.();
    await vi.waitFor(() => expect(plan.disabled).toBe(false));
    expect(call).toHaveBeenCalledOnce();
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

  it("removes shortcut listeners and detached controls stay inert after dispose", () => {
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
    const onSubmit = vi.fn();
    mounted.bind({
      onSubmit,
      onRetry: vi.fn(),
      onOpenNewConversation,
      onCancelNewConversation: vi.fn(),
      onConfirmNewConversation: vi.fn(),
    });
    const button = find(actionHost, (node) => node.className === "new-conversation-button");
    const dialog = find(actionHost, (node) => node.tagName === "dialog");
    const transcript = find(thread, (node) => node.className === "chat-transcript");
    const form = find(composerHost, (node) => node.className === "composer");
    const shortcutGroup = find(composerHost, (node) => node.className === "coaching-shortcuts");
    const shortcut = find(shortcutGroup, (node) => node.className === "coaching-shortcut");
    expect(shortcut.listeners.get("click")?.size).toBe(1);
    let state = reduceChatState(emptyState, { type: "session-probe", hasSession: true });
    state = reduceChatState(state, { type: "open-new-conversation" });
    mounted.view.render(state);
    expect(dialog.open).toBe(true);

    mounted.dispose();
    button.dispatch("click");
    shortcut.dispatch("click");
    expect(onOpenNewConversation).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(shortcut.listeners.get("click")?.size).toBe(0);
    expect(shortcutGroup.removed).toBe(true);
    expect(shortcutGroup.parentNode).toBeNull();
    expect(dialog.open).toBe(false);
    expect(dialog.removed).toBe(true);
    expect(button.removed).toBe(true);
    expect(transcript.removed).toBe(true);
    expect(form.removed).toBe(true);
  });
});
