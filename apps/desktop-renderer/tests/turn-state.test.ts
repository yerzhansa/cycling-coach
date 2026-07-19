import { describe, expect, it } from "vitest";
import { createChatTurn, reduceChatTurn } from "../src/turn-state.js";

describe("desktop turn state", () => {
  it("streams, replaces final text, and completes only on terminal", () => {
    let state = createChatTurn("How should I train?");
    state = reduceChatTurn(state, {
      type: "event",
      event: { type: "text_delta", turnId: "turn-1", delta: "Part" },
    });
    state = reduceChatTurn(state, {
      type: "event",
      event: { type: "final-text", turnId: "turn-1", text: "Complete answer" },
    });
    expect(state.assistant).toEqual({ status: "streaming", text: "Complete answer" });
    state = reduceChatTurn(state, { type: "success", text: "Complete answer" });
    expect(state.assistant).toEqual({ status: "completed", text: "Complete answer" });
  });

  it("preserves partial text as immutable aborted delivery", () => {
    let state = createChatTurn("Continue");
    state = reduceChatTurn(state, {
      type: "event",
      event: { type: "text_delta", turnId: "turn-1", delta: "Partial" },
    });
    const aborted = reduceChatTurn(state, { type: "abort" });
    expect(aborted.assistant).toEqual({ status: "aborted", text: "Partial", retryable: true });
    expect(
      reduceChatTurn(aborted, {
        type: "event",
        event: { type: "text_delta", turnId: "turn-1", delta: " late" },
      }),
    ).toBe(aborted);
    expect(
      reduceChatTurn(aborted, {
        type: "event",
        event: {
          type: "error",
          turnId: "turn-1",
          chatId: "desktop",
          error_class: "unknown",
          kind: "unknown",
          athleteMessage: "Late",
          overflowAttempts: 0,
          timeoutAttempts: 0,
          rateLimitAttempts: 0,
          duration_ms: 1,
          compactions: 0,
        },
      }),
    ).toBe(aborted);
    expect(reduceChatTurn(aborted, { type: "success", text: "Late" })).toBe(aborted);
  });

  it("keeps protocol failure non-retryable and exposes athlete error copy", () => {
    const protocol = reduceChatTurn(createChatTurn("Hello"), { type: "protocol-failure" });
    expect(protocol.assistant).toEqual({
      status: "failed",
      message: "The coaching connection returned an invalid response.",
    });
    const athlete = reduceChatTurn(createChatTurn("Hello"), {
      type: "event",
      event: {
        type: "error",
        turnId: "turn-1",
        chatId: "desktop",
        error_class: "unknown",
        kind: "unknown",
        athleteMessage: "Please retry later.",
        overflowAttempts: 0,
        timeoutAttempts: 0,
        rateLimitAttempts: 0,
        duration_ms: 1,
        compactions: 0,
      },
    });
    expect(athlete.assistant).toEqual({ status: "failed", message: "Please retry later." });
  });
});
