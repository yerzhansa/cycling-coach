import { describe, expect, it } from "vitest";
import {
  DESKTOP_CHAT_ID,
  EMPTY_CHAT_STATE,
  hasClearableConversation,
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
    expect(state.session.presence).toBe("present");
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

  it("records probe presence without letting a stale absence erase proven server presence", () => {
    const present = reduceChatState(EMPTY_CHAT_STATE, {
      type: "session-probe",
      hasSession: true,
    });
    expect(present.session.presence).toBe("present");

    const absent = reduceChatState(EMPTY_CHAT_STATE, {
      type: "session-probe",
      hasSession: false,
    });
    expect(absent.session.presence).toBe("absent");

    let completed = started();
    completed = reduceChatState(completed, {
      type: "event",
      requestKey: 1,
      event: { type: "final-text", turnId: "turn-1", text: "Done" },
    });
    completed = reduceChatState(completed, { type: "complete", requestKey: 1 });
    const fenced = reduceChatState(completed, { type: "session-probe", hasSession: false });
    expect(fenced).toBe(completed);
    expect(fenced.session.presence).toBe("present");
  });

  it("keeps server absence separate from visible local content that can be cleared", () => {
    const absent = reduceChatState(EMPTY_CHAT_STATE, {
      type: "session-probe",
      hasSession: false,
    });
    const placeholder: ChatState = {
      ...absent,
      messages: [
        {
          id: "message-1",
          role: "coach",
          text: "",
          delivery: "interrupted",
        },
      ],
    };

    expect(hasClearableConversation(placeholder)).toBe(false);
    expect(reduceChatState(placeholder, { type: "open-new-conversation" })).toBe(placeholder);

    let visible = reduceChatState(absent, {
      type: "submit",
      requestKey: 1,
      userMessage: "Keep this visible",
      userMessageId: "message-2",
      assistantMessageId: "message-3",
      includeUser: true,
    });
    visible = reduceChatState(visible, { type: "fail", requestKey: 1, copy: "Failed" });

    expect(visible.session.presence).toBe("absent");
    expect(hasClearableConversation(visible)).toBe(true);
    const confirming = reduceChatState(visible, { type: "open-new-conversation" });
    expect(confirming.session).toMatchObject({
      presence: "absent",
      resetPhase: "confirming",
    });
  });

  it("promotes presence only for an exact successful completion", () => {
    const absent = reduceChatState(EMPTY_CHAT_STATE, {
      type: "session-probe",
      hasSession: false,
    });
    let state = reduceChatState(absent, {
      type: "submit",
      requestKey: 4,
      userMessage: "How should I train?",
      userMessageId: "message-1",
      assistantMessageId: "message-2",
      includeUser: true,
    });

    expect(reduceChatState(state, { type: "complete", requestKey: 4 })).toBe(state);
    state = reduceChatState(state, {
      type: "event",
      requestKey: 4,
      event: { type: "final-text", turnId: "turn-4", text: "Train easy." },
    });
    expect(reduceChatState(state, { type: "complete", requestKey: 3 })).toBe(state);
    expect(state.session.presence).toBe("absent");

    const completed = reduceChatState(state, { type: "complete", requestKey: 4 });
    expect(completed.session.presence).toBe("present");
  });

  it("opens and cancels confirmation without changing conversation content", () => {
    const local = reduceChatState(started(), {
      type: "interrupt",
      requestKey: 1,
      copy: "Interrupted",
    });
    const confirming = reduceChatState(local, { type: "open-new-conversation" });
    expect(confirming.session.resetPhase).toBe("confirming");
    expect(confirming.messages).toBe(local.messages);
    expect(confirming.activeTurn).toBe(local.activeTurn);

    const cancelled = reduceChatState(confirming, { type: "cancel-new-conversation" });
    expect(cancelled.session.resetPhase).toBe("idle");
    expect(cancelled.messages).toBe(local.messages);
    expect(cancelled.activeTurn).toBe(local.activeTurn);
  });

  it.each([
    "New conversation started.",
    "New conversation started. Some recent details may not have been saved to coach memory.",
  ])("clears the turn after a successful reset announced as %s", (announcement) => {
    let state = started();
    state = reduceChatState(state, {
      type: "event",
      requestKey: 1,
      event: { type: "text_delta", turnId: "turn-1", delta: "Partial" },
    });
    state = reduceChatState(state, {
      type: "interrupt",
      requestKey: 1,
      copy: "Interrupted",
    });
    state = reduceChatState(state, { type: "open-new-conversation" });
    state = reduceChatState(state, { type: "begin-reset" });
    state = reduceChatState(state, { type: "reset-succeeded", announcement });

    expect(state).toEqual({
      status: "idle",
      messages: [],
      activeTurn: null,
      progress: null,
      session: {
        presence: "absent",
        resetPhase: "idle",
        resetCount: 1,
        announcement,
      },
    });
  });

  it("preserves the exact turn on an uncertain reset failure", () => {
    const local = reduceChatState(started(), {
      type: "interrupt",
      requestKey: 1,
      copy: "Interrupted",
    });
    let resetting = reduceChatState(local, { type: "open-new-conversation" });
    resetting = reduceChatState(resetting, { type: "begin-reset" });
    const failed = reduceChatState(resetting, {
      type: "reset-failed",
      announcement: "Uncertain",
    });

    expect(failed.status).toBe(local.status);
    expect(failed.messages).toBe(local.messages);
    expect(failed.activeTurn).toBe(local.activeTurn);
    expect(failed.progress).toBe(local.progress);
    expect(failed.session).toMatchObject({
      presence: "unknown",
      resetPhase: "uncertain",
      announcement: "Uncertain",
    });
  });

  it("clears a reset announcement only when the next submit is accepted", () => {
    const announced = {
      ...EMPTY_CHAT_STATE,
      session: {
        presence: "absent" as const,
        resetPhase: "idle" as const,
        resetCount: 3,
        announcement: "New conversation started.",
      },
    };
    const submitted = reduceChatState(announced, {
      type: "submit",
      requestKey: 4,
      userMessage: "What should I ride today?",
      userMessageId: "message-4",
      assistantMessageId: "message-5",
      includeUser: true,
    });

    expect(submitted.session).toEqual({
      presence: "absent",
      resetPhase: "idle",
      resetCount: 3,
      announcement: null,
    });

    const rejected = reduceChatState(
      {
        ...submitted,
        session: { ...submitted.session, announcement: "Keep this announcement." },
      },
      {
        type: "submit",
        requestKey: 5,
        userMessage: "Do not accept this yet.",
        userMessageId: "message-6",
        assistantMessageId: "message-7",
        includeUser: true,
      },
    );
    expect(rejected.session.announcement).toBe("Keep this announcement.");
  });

  it("ignores old turn events after reset success", () => {
    let state = started(7);
    state = reduceChatState(state, {
      type: "interrupt",
      requestKey: 7,
      copy: "Interrupted",
    });
    state = reduceChatState(state, { type: "open-new-conversation" });
    state = reduceChatState(state, { type: "begin-reset" });
    state = reduceChatState(state, {
      type: "reset-succeeded",
      announcement: "New conversation started.",
    });
    const stale = reduceChatState(state, {
      type: "event",
      requestKey: 7,
      event: { type: "text_delta", turnId: "turn-7", delta: "stale" },
    });

    expect(stale).toBe(state);
    expect(stale.messages).toEqual([]);
  });
});
