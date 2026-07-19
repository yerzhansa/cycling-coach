import { describe, expect, it } from "vitest";
import {
  DESKTOP_CHAT_ID,
  EMPTY_CHAT_STATE,
  reduceChatState,
  type ChatState,
} from "../src/turn-state.js";

function started(requestKey = 1): ChatState {
  return reduceChatState(EMPTY_CHAT_STATE, {
    type: "submit",
    requestKey,
    userMessage: "How should I train?",
    userMessageId: "message-1",
    assistantMessageId: "message-2",
    includeUser: true,
  });
}

describe("desktop turn state", () => {
  it("owns the one desktop conversation identity", () => {
    expect(DESKTOP_CHAT_ID).toBe("desktop");
  });

  it("streams ordered deltas and replaces them with canonical final text", () => {
    let state = started();
    state = reduceChatState(state, {
      type: "event",
      requestKey: 1,
      event: { type: "text_delta", turnId: "turn-1", delta: "Hel" },
    });
    state = reduceChatState(state, {
      type: "event",
      requestKey: 1,
      event: { type: "text_delta", turnId: "turn-1", delta: "lo" },
    });
    state = reduceChatState(state, {
      type: "event",
      requestKey: 1,
      event: { type: "final-text", turnId: "turn-1", text: "Hello." },
    });
    state = reduceChatState(state, { type: "complete", requestKey: 1 });
    expect(state.messages.at(-1)).toMatchObject({ text: "Hello.", delivery: "complete" });
  });

  it("accepts optional start and retains safe contract error fields", () => {
    let state = started();
    state = reduceChatState(state, {
      type: "event",
      requestKey: 1,
      event: { type: "turn-start", turnId: "turn-1", chatId: "desktop" },
    });
    state = reduceChatState(state, {
      type: "event",
      requestKey: 1,
      event: {
        type: "error",
        turnId: "turn-1",
        chatId: "desktop",
        error_class: "unknown",
        kind: "provider-down",
        athleteMessage: "Please try later.",
        overflowAttempts: 0,
        timeoutAttempts: 0,
        rateLimitAttempts: 0,
        duration_ms: 1,
        compactions: 0,
      },
    });
    expect(state.activeTurn?.error).toEqual({
      kind: "provider-down",
      athleteMessage: "Please try later.",
    });
  });

  it("ignores stale local request keys and preserves interrupted drafts", () => {
    let state = started(4);
    state = reduceChatState(state, {
      type: "event",
      requestKey: 4,
      event: { type: "text_delta", turnId: "turn-4", delta: "Partial" },
    });
    const stale = reduceChatState(state, {
      type: "event",
      requestKey: 3,
      event: { type: "text_delta", turnId: "turn-3", delta: " hidden" },
    });
    expect(stale).toBe(state);
    const interrupted = reduceChatState(state, {
      type: "interrupt",
      requestKey: 4,
      copy: "Connection interrupted. Your partial response is preserved.",
    });
    expect(interrupted.messages.at(-1)).toMatchObject({
      text: "Partial",
      delivery: "interrupted",
    });
  });
});
