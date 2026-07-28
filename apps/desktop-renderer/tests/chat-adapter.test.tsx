import { act, render } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatView, ChatViewControls } from "../src/chat/controller.js";
import { mergeHydratedMessages } from "../src/chat/hydration.js";
import { createChatViewAdapter } from "../src/state/adapters/chat.js";
import { EMPTY_CHAT_SURFACE, type ChatSurfaceState } from "../src/state/chat-slice.js";
import { createChatScrollAnchor, resetChatStream } from "../src/state/chat-stream.js";
import { useEnduragentStore } from "../src/state/store.js";
import {
  CHAT_WORKING_COPY,
  EMPTY_CHAT_STATE,
  reduceChatState,
  type ChatState,
} from "../src/turn-state.js";
import { ChatView as ChatSurface } from "../src/ui/chat/ChatView.js";

const TURN_ID = "turn-1";

function controls(patch: Partial<ChatViewControls> = {}): ChatViewControls {
  return {
    newConversationDisabled: true,
    workBlocked: false,
    hydration: { status: "ready", hasEarlier: false, revision: 1, change: "none" },
    ...patch,
  };
}

function submitted(message = "How is my form?"): ChatState {
  return reduceChatState(EMPTY_CHAT_STATE, {
    type: "submit",
    requestKey: 1,
    userMessage: message,
    userMessageId: "m1",
    assistantMessageId: "m2",
    includeUser: true,
  });
}

function delta(state: ChatState, text: string): { state: ChatState; controls: ChatViewControls } {
  const previousTextLength = state.activeTurn?.draft.length ?? 0;
  return {
    state: reduceChatState(state, {
      type: "event",
      requestKey: 1,
      event: { type: "text_delta", turnId: TURN_ID, delta: text },
    }),
    controls: controls({
      appendDelta: {
        messageId: "m2",
        previousTextLength,
        nextTextLength: previousTextLength + text.length,
        delta: text,
      },
    }),
  };
}

describe("chat view adapter", () => {
  afterEach(() => {
    resetChatStream();
  });

  it("satisfies the chat view port and projects controller state into a surface", () => {
    const published: ChatSurfaceState[] = [];
    const adapter = createChatViewAdapter({ publish: (next) => published.push(next) });
    const view: ChatView = adapter.view;

    view.render(
      submitted(),
      controls({
        newConversationDisabled: false,
        workBlocked: true,
        hydration: { status: "loading", hasEarlier: true, revision: 3, change: "prepend" },
      }),
    );

    expect(published).toHaveLength(1);
    expect(published[0]).toEqual({
      messages: [
        {
          id: "m1",
          role: "athlete",
          delivery: "complete",
          historical: false,
          text: "How is my form?",
        },
      ],
      status: "streaming",
      notice: CHAT_WORKING_COPY,
      interrupted: false,
      workBlocked: true,
      composerDisabled: true,
      newConversationUnavailable: false,
      resetPhase: "idle",
      resetCount: 0,
      announcement: null,
      hasHydratedHistory: false,
      hydrationStatus: "loading",
      hydrationHasEarlier: true,
      hydrationRevision: 3,
      hydrationChange: "prepend",
    });
  });

  it("derives the controls the port leaves optional", () => {
    const published: ChatSurfaceState[] = [];
    const adapter = createChatViewAdapter({ publish: (next) => published.push(next) });

    adapter.view.render(submitted());

    expect(published[0]).toMatchObject({
      workBlocked: false,
      newConversationUnavailable: true,
      composerDisabled: true,
      hydrationStatus: "idle",
      hydrationHasEarlier: false,
      hydrationRevision: 0,
      hydrationChange: "none",
    });
  });

  it("prefers the turn error copy over generic progress", () => {
    const published: ChatSurfaceState[] = [];
    const adapter = createChatViewAdapter({ publish: (next) => published.push(next) });
    const state = reduceChatState(submitted(), {
      type: "event",
      requestKey: 1,
      event: {
        type: "error",
        turnId: TURN_ID,
        chatId: "desktop",
        error_class: "unknown",
        kind: "provider-down",
        athleteMessage: "The coach is unreachable right now.",
        overflowAttempts: 0,
        timeoutAttempts: 0,
        rateLimitAttempts: 0,
        duration_ms: 12,
        compactions: 0,
      },
    });

    adapter.view.render(state, controls());

    expect(published.at(-1)?.notice).toBe("The coach is unreachable right now.");
  });

  it("carries hydrated history through the port and flags it for the reset copy", () => {
    const published: ChatSurfaceState[] = [];
    const adapter = createChatViewAdapter({ publish: (next) => published.push(next) });
    const live = submitted();

    adapter.view.render(
      {
        ...live,
        messages: mergeHydratedMessages(
          [
            {
              turnId: "persisted-1",
              completedAt: "2001-01-01T00:00:00.000Z",
              athleteText: "Persisted athlete",
              coachText: "Persisted coach",
            },
          ],
          live.messages,
        ),
      },
      controls(),
    );

    const surface = published.at(-1);
    expect(surface?.hasHydratedHistory).toBe(true);
    expect(surface?.messages.map((message) => [message.id, message.historical])).toEqual([
      ["history:athlete:persisted-1", true],
      ["history:coach:persisted-1", true],
      ["m1", false],
    ]);
  });

  it("rejects a transcript that repeats a message id", () => {
    const adapter = createChatViewAdapter({ publish: () => {} });
    const message = {
      id: "m1",
      role: "athlete",
      text: "one",
      delivery: "complete",
    } as const;

    expect(() =>
      adapter.view.render({ ...EMPTY_CHAT_STATE, messages: [message, message] }),
    ).toThrow(TypeError);
  });
});

describe("chat scroll anchor", () => {
  function host(scrollHeight: number, clientHeight: number, scrollTop: number): HTMLElement {
    const element = document.createElement("div");
    let height = scrollHeight;
    Object.defineProperty(element, "scrollHeight", { get: () => height, configurable: true });
    Object.defineProperty(element, "clientHeight", { get: () => clientHeight, configurable: true });
    element.scrollTop = scrollTop;
    Object.defineProperty(element, "grow", {
      value: (next: number) => {
        height = next;
      },
    });
    return element;
  }

  function grow(element: HTMLElement, next: number): void {
    (element as HTMLElement & { grow: (value: number) => void }).grow(next);
  }

  it("follows the newest message when the athlete is already at the bottom", () => {
    const anchor = createChatScrollAnchor();
    const element = host(1000, 400, 600);
    anchor.attach(element);

    anchor.capture();
    grow(element, 1200);
    anchor.apply({ hydrationChanged: false, hydrationChange: "none" });

    expect(element.scrollTop).toBe(1200);
  });

  it("leaves the viewport alone when the athlete has scrolled up", () => {
    const anchor = createChatScrollAnchor();
    const element = host(1000, 400, 100);
    anchor.attach(element);

    anchor.capture();
    grow(element, 1200);
    anchor.apply({ hydrationChanged: false, hydrationChange: "none" });

    expect(element.scrollTop).toBe(100);
  });

  it("jumps to the newest message on the initial hydration", () => {
    const anchor = createChatScrollAnchor();
    const element = host(1000, 400, 0);
    anchor.attach(element);

    anchor.capture();
    grow(element, 2000);
    anchor.apply({ hydrationChanged: true, hydrationChange: "initial" });

    expect(element.scrollTop).toBe(2000);
  });

  it("holds the anchor row in place when the layout above it shifts", () => {
    const anchor = createChatScrollAnchor();
    const element = host(1000, 400, 100);
    document.body.append(element);
    const row = document.createElement("article");
    row.className = "chat-message";
    element.append(row);
    let rowTop = 300;
    row.getBoundingClientRect = () =>
      ({ top: rowTop, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0 }) as DOMRect;
    anchor.attach(element);

    anchor.capture();
    rowTop = 520;
    grow(element, 1400);
    anchor.apply({ hydrationChanged: true, hydrationChange: "prepend" });

    expect(element.scrollTop).toBe(320);
    element.remove();
  });

  it("preserves the reading position when earlier messages are prepended", () => {
    const anchor = createChatScrollAnchor();
    const element = host(1000, 400, 120);
    anchor.attach(element);

    anchor.capture();
    grow(element, 1700);
    anchor.apply({ hydrationChanged: true, hydrationChange: "prepend" });

    expect(element.scrollTop).toBe(820);
  });
});

const renders = { transcript: 0 };

function Probe(): null {
  useEnduragentStore((state) => state.chat.messages);
  renders.transcript += 1;
  return null;
}

function Harness(): ReactElement {
  return (
    <>
      <ChatSurface />
      <Probe />
    </>
  );
}

function coachText(): string {
  return document.querySelector(".chat-message--coach .chat-message__text")?.textContent ?? "";
}

describe("streaming fast path", () => {
  beforeEach(() => {
    renders.transcript = 0;
    useEnduragentStore.setState({
      activeView: "chat",
      chat: EMPTY_CHAT_SURFACE,
      firstSync: { status: "idle" },
      chatActions: null,
    });
  });

  afterEach(() => {
    useEnduragentStore.setState({ chat: EMPTY_CHAT_SURFACE });
    resetChatStream();
  });

  it("appends deltas into the transcript without re-rendering the message list", () => {
    const adapter = createChatViewAdapter({
      publish: (next) => useEnduragentStore.getState().setChatSurface(next),
    });
    const send = (state: ChatState, next?: ChatViewControls): void => {
      act(() => {
        adapter.view.render(state, next);
      });
    };

    render(<Harness />);
    const mounted = renders.transcript;

    let state = submitted("Plan my week");
    send(state, controls());
    expect(renders.transcript).toBe(mounted + 1);
    expect(document.querySelectorAll(".chat-message")).toHaveLength(1);

    const first = delta(state, "Ride ");
    state = first.state;
    send(state, first.controls);
    const afterFirstDelta = renders.transcript;
    expect(afterFirstDelta).toBe(mounted + 2);
    expect(document.querySelectorAll(".chat-message")).toHaveLength(2);
    const textNode = document.querySelector(".chat-message--coach .chat-message__text");

    for (const chunk of ["steady ", "on ", "Tuesday."]) {
      const step = delta(state, chunk);
      state = step.state;
      send(state, step.controls);
    }

    expect(renders.transcript).toBe(afterFirstDelta);
    expect(coachText()).toBe("Ride steady on Tuesday.");
    expect(document.querySelector(".chat-message--coach .chat-message__text")).toBe(textNode);
    expect(document.querySelectorAll(".chat-message")).toHaveLength(2);

    state = reduceChatState(state, {
      type: "event",
      requestKey: 1,
      event: { type: "final-text", turnId: TURN_ID, text: "Ride **steady** on Tuesday." },
    });
    send(state, controls());
    expect(renders.transcript).toBe(afterFirstDelta);
    expect(coachText()).toBe("Ride **steady** on Tuesday.");

    state = reduceChatState(state, { type: "complete", requestKey: 1 });
    send(state, controls({ newConversationDisabled: false }));
    expect(renders.transcript).toBe(afterFirstDelta + 1);
    expect(document.querySelector(".chat-message--coach strong")?.textContent).toBe("steady");
    expect(document.querySelector(".chat-message--coach")?.hasAttribute("aria-busy")).toBe(false);
  });

  it("keeps the coach row and its streaming target across the whole turn", () => {
    const adapter = createChatViewAdapter({
      publish: (next) => useEnduragentStore.getState().setChatSurface(next),
    });
    const send = (state: ChatState, next?: ChatViewControls): void => {
      act(() => {
        adapter.view.render(state, next);
      });
    };

    render(<Harness />);
    let state = submitted("Plan my week");
    send(state, controls());
    const first = delta(state, "Easy spin.");
    state = first.state;
    send(state, first.controls);

    const row = document.querySelector(".chat-message--coach");
    expect(row?.getAttribute("aria-busy")).toBe("true");

    state = reduceChatState(state, {
      type: "event",
      requestKey: 1,
      event: { type: "final-text", turnId: TURN_ID, text: "Easy spin." },
    });
    send(state, controls());
    state = reduceChatState(state, { type: "complete", requestKey: 1 });
    send(state, controls({ newConversationDisabled: false }));

    expect(document.querySelector(".chat-message--coach")).toBe(row);
    expect(coachText()).toBe("Easy spin.");
  });
});
