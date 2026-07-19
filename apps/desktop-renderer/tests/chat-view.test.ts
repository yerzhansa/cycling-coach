import { beforeEach, describe, expect, it, vi } from "vitest";
import { mountChatView } from "../src/chat/view.js";
import type { ChatState } from "../src/turn-state.js";

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
