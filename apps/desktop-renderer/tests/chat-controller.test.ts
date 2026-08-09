import { describe, expect, it, vi } from "vitest";
import {
  CoachClientCallAbortedError,
  CoachClientCallTimeoutError,
  CoachClientDisconnectedError,
  CoachClientProtocolError,
  type CoachClient,
  type CoachClientCallOptions,
} from "@enduragent/coach-client";
import type { CoachTurnEventNotificationEnvelope, TurnEvent } from "@enduragent/coach-contract";
import {
  CHAT_CONNECTION_INTERRUPTED_COPY,
  CHAT_EMPTY_RESPONSE_COPY,
  CHAT_FAILURE_COPY,
  CHAT_PROTOCOL_FAILURE_COPY,
  NEW_CONVERSATION_MEMORY_WARNING_COPY,
  NEW_CONVERSATION_SUCCESS_COPY,
  NEW_CONVERSATION_UNCERTAIN_COPY,
  type ChatViewControls,
  createChatController,
} from "../src/chat/controller.js";
import { COACH_RESPONSE_CODE_UNIT_LIMIT, COACH_TURN_EVENT_LIMIT } from "../src/chat/limits.js";
import type { DesktopCoachClientProvider } from "../src/coach-client.js";
import { CHAT_WORKING_COPY, EMPTY_CHAT_STATE, type ChatState } from "../src/turn-state.js";

function envelope(event: TurnEvent, requestId = 1): CoachTurnEventNotificationEnvelope {
  return {
    jsonrpc: "2.0",
    method: "coach.turnEvent",
    params: {
      requestId,
      requestMethod: "chat",
      turnId: event.turnId,
      event,
    },
  };
}

function errorEvent(message = "Safe athlete message"): Extract<TurnEvent, { type: "error" }> {
  return {
    type: "error",
    turnId: "turn-1",
    chatId: "desktop",
    error_class: "unknown",
    kind: "provider-down",
    athleteMessage: message,
    overflowAttempts: 0,
    timeoutAttempts: 0,
    rateLimitAttempts: 0,
    duration_ms: 1,
    compactions: 0,
  };
}

function deliver(options: CoachClientCallOptions<"chat"> | undefined, event: TurnEvent): void {
  options?.onNotificationEnvelope?.(envelope(event));
  options?.onEvent?.(event);
}

function rejectWhenAborted(options: CoachClientCallOptions<"chat"> | undefined): Promise<never> {
  return new Promise((_, reject) => {
    const signal = options?.signal;
    if (signal === undefined) {
      reject(new TypeError("missing call abort signal"));
      return;
    }
    const rejectAbort = (): void => reject(new CoachClientCallAbortedError("chat"));
    if (signal.aborted) rejectAbort();
    else signal.addEventListener("abort", rejectAbort, { once: true });
  });
}

function client(
  implementation: (
    request: { chatId: string; message: string },
    options: CoachClientCallOptions<"chat"> | undefined,
  ) => Promise<{ text: string }>,
  sessions: {
    readonly hasSession?: (request: { chatId: string }) => Promise<{ hasSession: boolean }>;
    readonly resetSession?: (request: { chatId: string }) => Promise<{ memoryFlushed: boolean }>;
  } = {},
): CoachClient {
  return {
    handshake: {} as CoachClient["handshake"],
    call: vi.fn((method, request, options) => {
      if (method === "hasSession") {
        return (sessions.hasSession ?? (async () => ({ hasSession: false })))(
          request as { chatId: string },
        ) as never;
      }
      if (method === "resetSession") {
        return (sessions.resetSession ?? (async () => ({ memoryFlushed: true })))(
          request as { chatId: string },
        ) as never;
      }
      if (method !== "chat") throw new TypeError();
      return implementation(
        request as { chatId: string; message: string },
        options as CoachClientCallOptions<"chat">,
      ) as never;
    }),
    close: vi.fn(async () => {}),
  };
}

function replies(
  gate?: () => Promise<void>,
): (
  request: { chatId: string; message: string },
  options: CoachClientCallOptions<"chat"> | undefined,
) => Promise<{ text: string }> {
  let turn = 0;
  return async (_request, options) => {
    turn += 1;
    if (turn === 1 && gate !== undefined) await gate();
    const text = `Reply ${turn}`;
    deliver(options, { type: "final-text", turnId: `turn-${turn}`, text });
    options?.onTerminalEnvelope?.({ jsonrpc: "2.0", id: turn, result: { text } });
    return { text };
  };
}

function chatMessages(fake: CoachClient): readonly string[] {
  return vi
    .mocked(fake.call)
    .mock.calls.filter(([method]) => method === "chat")
    .map(([, request]) => (request as { message: string }).message);
}

function subject(
  first: CoachClient,
  reconnected: CoachClient = first,
  refreshImplementation: () => Promise<void> = async () => {},
  spendRefreshImplementation: () => Promise<void> = async () => {},
  canChat: () => boolean = () => true,
) {
  const states: ChatState[] = [];
  const controls: ChatViewControls[] = [];
  const refresh = vi.fn(refreshImplementation);
  const refreshSpend = vi.fn(spendRefreshImplementation);
  const provider: DesktopCoachClientProvider = {
    getClient: vi.fn(async () => first),
    reconnect: vi.fn(async () => reconnected),
    close: vi.fn(async () => {}),
  };
  const controller = createChatController({
    clients: provider,
    view: {
      render: (state, nextControls) => {
        states.push(structuredClone(state));
        if (nextControls !== undefined) controls.push(structuredClone(nextControls));
      },
    },
    refreshTrainingContext: refresh,
    refreshSpend,
    canChat,
  });
  return { controller, provider, states, controls, refresh, refreshSpend };
}

describe("chat controller", () => {
  it("keeps submit, reset, and queued drain inert while setup is not ready", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ready = false;
    const fake = client(replies(() => gate));
    const { controller, states } = subject(
      fake,
      fake,
      async () => {},
      async () => {},
      () => ready,
    );

    await controller.submit("Blocked");
    expect(chatMessages(fake)).toEqual([]);
    expect(controller.openNewConversation()).toBe(false);

    ready = true;
    const first = controller.submit("Allowed");
    await Promise.resolve();
    await controller.submit("Queued");
    ready = false;
    release();
    await first;

    expect(chatMessages(fake)).toEqual(["Allowed"]);
    expect(states.at(-1)?.queued).toMatchObject([{ text: "Queued" }]);
    expect(controller.openNewConversation()).toBe(false);
  });

  it("resumes a readiness-blocked queue exactly once", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ready = true;
    const fake = client(replies(() => gate));
    const { controller, states } = subject(
      fake,
      fake,
      async () => {},
      async () => {},
      () => ready,
    );

    const first = controller.submit("Allowed");
    await Promise.resolve();
    await controller.submit("Queued");
    ready = false;
    release();
    await first;

    expect(chatMessages(fake)).toEqual(["Allowed"]);
    expect(states.at(-1)?.queued).toMatchObject([{ text: "Queued" }]);

    ready = true;
    await Promise.all([controller.resume(), controller.resume(), controller.resume()]);

    expect(chatMessages(fake)).toEqual(["Allowed", "Queued"]);
    expect(states.at(-1)?.queued).toEqual([]);
  });

  it("renders the reauthentication copy instead of the generic failure copy", async () => {
    const reauthenticationCopy =
      "Your ChatGPT sign-in is no longer valid. Open Setup and sign in again.";
    const fake = client(async (_request, options) => {
      deliver(options, {
        ...errorEvent(reauthenticationCopy),
        kind: "provider-auth",
      });
      options?.onTerminalEnvelope?.({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32603, message: "Internal error" },
      });
      throw new Error("remote detail");
    });
    const { controller, states } = subject(fake);

    await controller.submit("Help");

    expect(states.at(-1)?.messages.at(-1)?.text).toBe("");
    expect(states.at(-1)?.activeTurn?.error?.athleteMessage).toBe(reauthenticationCopy);
    expect(states.at(-1)?.progress).toBeNull();
    expect(states.at(-1)?.status).toBe("idle");
  });

  it("keeps a transient provider failure retryable without reauthentication copy", async () => {
    const transientCopy = "The model provider is having trouble — try again in a few minutes.";
    const fake = client(async (_request, options) => {
      deliver(options, errorEvent(transientCopy));
      options?.onTerminalEnvelope?.({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32603, message: "Internal error" },
      });
      throw new Error("remote detail");
    });
    const { controller, states } = subject(fake);

    await controller.submit("Help");

    expect(states.at(-1)?.messages.at(-1)?.text).toBe("");
    expect(states.at(-1)?.activeTurn?.error?.athleteMessage).toBe(transientCopy);
    expect(states.at(-1)?.activeTurn?.error?.athleteMessage).not.toContain("sign in again");
  });

  it("does not wait for spend refresh before settling a completed chat", async () => {
    const gate = new Promise<void>(() => {});
    const fake = client(async (_request, options) => {
      deliver(options, { type: "final-text", turnId: "turn-1", text: "Done" });
      options?.onTerminalEnvelope?.({ jsonrpc: "2.0", id: 1, result: { text: "Done" } });
      return { text: "Done" };
    });
    const { controller, refreshSpend } = subject(
      fake,
      fake,
      async () => {},
      () => gate,
    );
    await expect(controller.submit("Continue")).resolves.toBeUndefined();
    expect(refreshSpend).toHaveBeenCalledTimes(1);
  });

  it("publishes working feedback immediately for an accepted submit", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fake = client(async (_request, options) => {
      await gate;
      deliver(options, { type: "final-text", turnId: "turn-1", text: "Done" });
      options?.onTerminalEnvelope?.({ jsonrpc: "2.0", id: 1, result: { text: "Done" } });
      return { text: "Done" };
    });
    const { controller, states } = subject(fake);

    const submission = controller.submit("Continue");

    expect(states.at(-1)).toMatchObject({
      status: "streaming",
      progress: CHAT_WORKING_COPY,
      messages: [
        { role: "athlete", text: "Continue" },
        { role: "coach", text: "", delivery: "streaming" },
      ],
    });

    release();
    await submission;
  });

  it("clears only generic working feedback on the first substantive delta", async () => {
    const fake = client(async (_request, options) => {
      deliver(options, { type: "text_delta", turnId: "turn-1", delta: " \n" });
      deliver(options, { type: "text_delta", turnId: "turn-1", delta: "Ride easy." });
      deliver(options, { type: "final-text", turnId: "turn-1", text: "Ride easy." });
      options?.onTerminalEnvelope?.({ jsonrpc: "2.0", id: 1, result: { text: "Ride easy." } });
      return { text: "Ride easy." };
    });
    const { controller, states } = subject(fake);

    await controller.submit("Continue");

    const whitespace = states.find((state) => state.activeTurn?.draft === " \n");
    expect(whitespace?.progress).toBe(CHAT_WORKING_COPY);
    expect(whitespace?.messages.at(-1)?.text).toBe("");
    const firstText = states.find((state) => state.activeTurn?.draft === " \nRide easy.");
    expect(firstText?.progress).toBeNull();
    expect(firstText?.messages.at(-1)?.text).toBe(" \nRide easy.");
  });

  it("renders ordered deltas immediately and canonical final text once without turn-start", async () => {
    const fake = client(async (_request, options) => {
      deliver(options, { type: "text_delta", turnId: "turn-1", delta: "Hel" });
      deliver(options, { type: "text_delta", turnId: "turn-1", delta: "lo" });
      deliver(options, { type: "final-text", turnId: "turn-1", text: "Hello." });
      options?.onTerminalEnvelope?.({ jsonrpc: "2.0", id: 1, result: { text: "Hello." } });
      return { text: "Hello." };
    });
    const { controller, states, refresh, refreshSpend } = subject(fake);
    await controller.submit("Original message ");
    expect(states.some((state) => state.messages.at(-1)?.text === "Hel")).toBe(true);
    expect(states.at(-1)?.messages.filter((message) => message.text === "Hello.")).toHaveLength(1);
    expect(states.at(-1)?.session.presence).toBe("present");
    expect(vi.mocked(fake.call).mock.calls[0]?.slice(0, 2)).toEqual([
      "chat",
      { chatId: "desktop", message: "Original message " },
    ]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refreshSpend).toHaveBeenCalledTimes(1);
  });

  it("admits cumulative text deltas at the exact response boundary", async () => {
    const first = "🚴".repeat(30_000);
    const second = "b".repeat(COACH_RESPONSE_CODE_UNIT_LIMIT - first.length);
    let signal: AbortSignal | undefined;
    const fake = client(async (_request, options) => {
      signal = options?.signal;
      deliver(options, { type: "text_delta", turnId: "turn-1", delta: first });
      deliver(options, { type: "text_delta", turnId: "turn-1", delta: second });
      deliver(options, { type: "final-text", turnId: "turn-1", text: "Done" });
      options?.onTerminalEnvelope?.({ jsonrpc: "2.0", id: 1, result: { text: "Done" } });
      return { text: "Done" };
    });
    const { controller, states, controls } = subject(fake);

    await controller.submit("Continue");

    expect(
      states.some((state) => state.activeTurn?.draft.length === COACH_RESPONSE_CODE_UNIT_LIMIT),
    ).toBe(true);
    expect(controls.filter((control) => control.appendDelta).at(-1)?.appendDelta).toEqual({
      messageId: "message-3",
      previousTextLength: first.length,
      nextTextLength: COACH_RESPONSE_CODE_UNIT_LIMIT,
      delta: second,
    });
    expect(states.at(-1)?.messages.at(-1)?.text).toBe("Done");
    expect(signal?.aborted).toBe(false);
  });

  it("rejects one cumulative delta code unit over the response boundary", async () => {
    const admitted = "a".repeat(COACH_RESPONSE_CODE_UNIT_LIMIT);
    let signal: AbortSignal | undefined;
    const fake = client(async (_request, options) => {
      signal = options?.signal;
      const aborted = rejectWhenAborted(options);
      deliver(options, { type: "text_delta", turnId: "turn-1", delta: admitted });
      deliver(options, { type: "text_delta", turnId: "turn-1", delta: "b" });
      return aborted;
    });
    const { controller, states } = subject(fake);

    await controller.submit("Continue");

    expect(states.at(-1)).toMatchObject({
      status: "interrupted",
      progress: CHAT_PROTOCOL_FAILURE_COPY,
    });
    expect(states.at(-1)?.messages.at(-1)?.text).toBe(admitted);
    expect(signal?.aborted).toBe(true);
  });

  it("admits final text at the exact response boundary", async () => {
    const finalText = "🚴".repeat(COACH_RESPONSE_CODE_UNIT_LIMIT / 2);
    let signal: AbortSignal | undefined;
    const fake = client(async (_request, options) => {
      signal = options?.signal;
      deliver(options, { type: "final-text", turnId: "turn-1", text: finalText });
      options?.onTerminalEnvelope?.({ jsonrpc: "2.0", id: 1, result: { text: finalText } });
      return { text: finalText };
    });
    const { controller, states } = subject(fake);

    await controller.submit("Continue");

    expect(states.at(-1)?.messages.at(-1)).toMatchObject({
      text: finalText,
      delivery: "complete",
    });
    expect(signal?.aborted).toBe(false);
  });

  it("rejects final text one code unit over the response boundary", async () => {
    const oversized = `${"🚴".repeat(COACH_RESPONSE_CODE_UNIT_LIMIT / 2)}x`;
    let signal: AbortSignal | undefined;
    const fake = client(async (_request, options) => {
      signal = options?.signal;
      const aborted = rejectWhenAborted(options);
      deliver(options, { type: "text_delta", turnId: "turn-1", delta: "Preserved" });
      deliver(options, { type: "final-text", turnId: "turn-1", text: oversized });
      return aborted;
    });
    const { controller, states } = subject(fake);

    await controller.submit("Continue");

    expect(states.at(-1)).toMatchObject({
      status: "interrupted",
      progress: CHAT_PROTOCOL_FAILURE_COPY,
    });
    expect(states.at(-1)?.messages.at(-1)?.text).toBe("Preserved");
    expect(states.some((state) => state.messages.at(-1)?.text === oversized)).toBe(false);
    expect(signal?.aborted).toBe(true);
  });

  it("admits the final event at the exact turn-event boundary", async () => {
    let signal: AbortSignal | undefined;
    const fake = client(async (_request, options) => {
      signal = options?.signal;
      for (let index = 0; index < COACH_TURN_EVENT_LIMIT - 1; index += 1) {
        deliver(options, { type: "step-text", turnId: "turn-1", text: "Checking" });
      }
      deliver(options, { type: "final-text", turnId: "turn-1", text: "Done" });
      options?.onTerminalEnvelope?.({ jsonrpc: "2.0", id: 1, result: { text: "Done" } });
      return { text: "Done" };
    });
    const { controller, states } = subject(fake);

    await controller.submit("Continue");

    expect(states.at(-1)?.messages.at(-1)).toMatchObject({
      text: "Done",
      delivery: "complete",
    });
    expect(signal?.aborted).toBe(false);
  });

  it("rejects one turn event over the boundary and preserves admitted text", async () => {
    let signal: AbortSignal | undefined;
    const fake = client(async (_request, options) => {
      signal = options?.signal;
      const aborted = rejectWhenAborted(options);
      deliver(options, { type: "text_delta", turnId: "turn-1", delta: "Preserved" });
      for (let index = 1; index < COACH_TURN_EVENT_LIMIT; index += 1) {
        deliver(options, { type: "step-text", turnId: "turn-1", text: "Checking" });
      }
      deliver(options, { type: "final-text", turnId: "turn-1", text: "Rejected" });
      return aborted;
    });
    const { controller, states } = subject(fake);

    await controller.submit("Continue");

    expect(states.at(-1)).toMatchObject({
      status: "interrupted",
      progress: CHAT_PROTOCOL_FAILURE_COPY,
    });
    expect(states.at(-1)?.messages.at(-1)?.text).toBe("Preserved");
    expect(states.some((state) => state.messages.at(-1)?.text === "Rejected")).toBe(false);
    expect(signal?.aborted).toBe(true);
  });

  it("preserves partial text and the contract athlete message without automatic retry", async () => {
    const fake = client(async (_request, options) => {
      deliver(options, { type: "text_delta", turnId: "turn-1", delta: "Partial" });
      deliver(options, errorEvent());
      options?.onTerminalEnvelope?.({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32603, message: "Internal error" },
      });
      throw new Error("remote detail");
    });
    const { controller, states } = subject(fake);
    await controller.submit("Help");
    expect(states.at(-1)?.messages.at(-1)?.text).toBe("Partial");
    expect(states.at(-1)?.activeTurn?.error?.athleteMessage).toBe("Safe athlete message");
    expect(fake.call).toHaveBeenCalledTimes(1);
  });

  it("reconciles a safe final after an error while retaining the subdued notice", async () => {
    const fake = client(async (_request, options) => {
      deliver(options, { type: "text_delta", turnId: "turn-1", delta: "Draft" });
      deliver(options, errorEvent());
      deliver(options, { type: "final-text", turnId: "turn-1", text: "Safe fallback" });
      options?.onTerminalEnvelope?.({ jsonrpc: "2.0", id: 1, result: { text: "Safe fallback" } });
      return { text: "Safe fallback" };
    });
    const { controller, states } = subject(fake);
    await controller.submit("Help");
    expect(states.at(-1)?.messages.at(-1)?.text).toBe("Safe fallback");
    expect(states.at(-1)?.activeTurn?.error?.athleteMessage).toBe("Safe athlete message");
  });

  it.each(["missing", "mismatch"])(
    "treats a %s final confirmation as a safe protocol interruption",
    async (variant) => {
      const fake = client(async (_request, options) => {
        deliver(options, { type: "text_delta", turnId: "turn-1", delta: "Draft" });
        if (variant === "mismatch") {
          deliver(options, { type: "final-text", turnId: "turn-1", text: "Canonical" });
        }
        options?.onTerminalEnvelope?.({ jsonrpc: "2.0", id: 1, result: { text: "Other" } });
        return { text: "Other" };
      });
      const { controller, states } = subject(fake);
      await controller.submit("Help");
      expect(states.at(-1)).toMatchObject({
        status: "interrupted",
        progress: CHAT_PROTOCOL_FAILURE_COPY,
      });
      expect(states.at(-1)?.messages.at(-1)?.text).toBe(
        variant === "mismatch" ? "Canonical" : "Draft",
      );
    },
  );

  it.each([
    { finalText: "", partial: "" },
    { finalText: " \n\t", partial: "Preserved partial" },
  ])(
    "keeps a matching whitespace-only terminal retryable without completing %#",
    async ({ finalText, partial }) => {
      const fake = client(async (_request, options) => {
        if (partial.length > 0) {
          deliver(options, { type: "text_delta", turnId: "turn-1", delta: partial });
        }
        deliver(options, { type: "final-text", turnId: "turn-1", text: finalText });
        options?.onTerminalEnvelope?.({ jsonrpc: "2.0", id: 1, result: { text: finalText } });
        return { text: finalText };
      });
      const { controller, states } = subject(fake);
      await controller.start();

      await controller.submit("Help");

      expect(states.at(-1)).toMatchObject({
        status: "interrupted",
        progress: CHAT_EMPTY_RESPONSE_COPY,
        session: { presence: "absent" },
      });
      expect(states.at(-1)?.messages).toMatchObject([
        { role: "athlete", text: "Help", delivery: "complete" },
        { role: "coach", text: partial, delivery: "interrupted" },
      ]);
      expect(
        states.some(
          (state) =>
            state.messages.at(-1)?.delivery === "complete" &&
            !/\S/u.test(state.messages.at(-1)?.text ?? ""),
        ),
      ).toBe(false);
    },
  );

  it("accepts one matching first turn-start and rejects a late start", async () => {
    const fake = client(async (_request, options) => {
      deliver(options, { type: "text_delta", turnId: "turn-1", delta: "Draft" });
      deliver(options, { type: "turn-start", turnId: "turn-1", chatId: "desktop" });
      deliver(options, { type: "final-text", turnId: "turn-1", text: "Final" });
      options?.onTerminalEnvelope?.({ jsonrpc: "2.0", id: 1, result: { text: "Final" } });
      return { text: "Final" };
    });
    const { controller, states } = subject(fake);
    await controller.submit("Help");
    expect(states.at(-1)?.progress).toBe(CHAT_PROTOCOL_FAILURE_COPY);
  });

  it("preserves a disconnected draft and retries explicitly without duplicating the user row", async () => {
    const first = client(async (_request, options) => {
      deliver(options, { type: "text_delta", turnId: "turn-1", delta: "Partial" });
      throw new CoachClientDisconnectedError(1006, "synthetic");
    });
    const second = client(async (_request, options) => {
      deliver(options, { type: "final-text", turnId: "turn-2", text: "Recovered" });
      options?.onTerminalEnvelope?.({ jsonrpc: "2.0", id: 2, result: { text: "Recovered" } });
      return { text: "Recovered" };
    });
    const { controller, provider, states, refresh } = subject(first, second);
    await controller.submit("Same message");
    expect(states.at(-1)?.progress).toBe(CHAT_CONNECTION_INTERRUPTED_COPY);
    const retry = controller.retryInterrupted();
    expect(states.at(-1)?.progress).toBe(CHAT_WORKING_COPY);
    expect(states.at(-1)?.messages.filter((message) => message.role === "athlete")).toHaveLength(1);
    await retry;
    expect(provider.reconnect).toHaveBeenCalledTimes(1);
    expect(vi.mocked(second.call).mock.calls[0]?.[1]).toEqual({
      chatId: "desktop",
      message: "Same message",
    });
    expect(states.at(-1)?.messages.filter((message) => message.role === "athlete")).toHaveLength(1);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it.each([
    new CoachClientCallTimeoutError("chat", 11 * 60_000),
    new CoachClientCallAbortedError("chat"),
  ])(
    "preserves a draft after $name and makes one new call only on explicit retry",
    async (failure) => {
      const first = client(async (_request, options) => {
        deliver(options, { type: "text_delta", turnId: "turn-1", delta: "Partial" });
        throw failure;
      });
      const second = client(async (_request, options) => {
        deliver(options, { type: "final-text", turnId: "turn-2", text: "Recovered" });
        options?.onTerminalEnvelope?.({
          jsonrpc: "2.0",
          id: 2,
          result: { text: "Recovered" },
        });
        return { text: "Recovered" };
      });
      const { controller, provider, states } = subject(first, second);

      await controller.submit("Same message");

      expect(states.at(-1)?.status).toBe("interrupted");
      expect(states.at(-1)?.progress).toBe(CHAT_CONNECTION_INTERRUPTED_COPY);
      expect(states.at(-1)?.messages.at(-1)?.text).toBe("Partial");
      expect(first.call).toHaveBeenCalledTimes(1);
      expect(second.call).not.toHaveBeenCalled();
      expect(provider.reconnect).not.toHaveBeenCalled();

      await controller.retryInterrupted();

      expect(second.call).toHaveBeenCalledTimes(1);
      expect(states.at(-1)?.messages.filter((message) => message.role === "athlete")).toHaveLength(
        1,
      );
      expect(states.at(-1)?.messages.at(-1)?.text).toBe("Recovered");
    },
  );

  it("reuses a shared recovered client when retrying a stale interrupted turn", async () => {
    let current: CoachClient;
    const recovered = client(async (_request, options) => {
      deliver(options, { type: "final-text", turnId: "turn-2", text: "Recovered" });
      options?.onTerminalEnvelope?.({ jsonrpc: "2.0", id: 2, result: { text: "Recovered" } });
      return { text: "Recovered" };
    });
    const failed = client(async () => {
      current = recovered;
      throw new CoachClientDisconnectedError(1006, "synthetic");
    });
    current = failed;
    const provider: DesktopCoachClientProvider = {
      getClient: vi.fn(async () => current),
      reconnect: vi.fn(async () => recovered),
      close: vi.fn(async () => {}),
    };
    const states: ChatState[] = [];
    const controller = createChatController({
      clients: provider,
      view: { render: (state) => states.push(structuredClone(state)) },
      refreshTrainingContext: vi.fn(async () => {}),
      refreshSpend: vi.fn(async () => {}),
    });
    await controller.submit("Same message");
    await controller.retryInterrupted();
    expect(provider.reconnect).not.toHaveBeenCalled();
    expect(recovered.call).toHaveBeenCalledTimes(1);
    expect(states.at(-1)?.messages.at(-1)?.text).toBe("Recovered");
  });

  it("queues one explicit retry while terminal state refresh is still running", async () => {
    let release!: () => void;
    const refreshGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let refreshCalls = 0;
    const first = client(async (_request, options) => {
      deliver(options, { type: "text_delta", turnId: "turn-1", delta: "Partial" });
      throw new CoachClientDisconnectedError(1006, "synthetic");
    });
    const second = client(async (_request, options) => {
      deliver(options, { type: "final-text", turnId: "turn-2", text: "Recovered" });
      options?.onTerminalEnvelope?.({ jsonrpc: "2.0", id: 2, result: { text: "Recovered" } });
      return { text: "Recovered" };
    });
    let interrupted!: () => void;
    const interruptedState = new Promise<void>((resolve) => {
      interrupted = resolve;
    });
    const provider: DesktopCoachClientProvider = {
      getClient: vi.fn(async () => first),
      reconnect: vi.fn(async () => second),
      close: vi.fn(async () => {}),
    };
    let latestState = EMPTY_CHAT_STATE;
    const controller = createChatController({
      clients: provider,
      view: {
        render(state) {
          latestState = structuredClone(state);
          if (state.status === "interrupted") interrupted();
        },
      },
      refreshTrainingContext: vi.fn(async () => {
        refreshCalls += 1;
        if (refreshCalls === 1) await refreshGate;
      }),
      refreshSpend: vi.fn(async () => {}),
    });
    const submission = controller.submit("Same message");
    await interruptedState;
    const retry = controller.retryInterrupted();
    const duplicate = controller.retryInterrupted();
    expect(latestState.progress).toBe(CHAT_WORKING_COPY);
    expect(latestState.messages.filter((message) => message.role === "athlete")).toHaveLength(1);
    expect(controller.openNewConversation()).toBe(false);
    release();
    await Promise.all([submission, retry, duplicate]);
    expect(provider.reconnect).toHaveBeenCalledTimes(1);
    expect(second.call).toHaveBeenCalledTimes(1);
  });

  it("keeps queued retries owned by the interrupted request when a newer pre-call disconnects", async () => {
    let releaseFirstRefresh!: () => void;
    const firstRefreshGate = new Promise<void>((resolve) => {
      releaseFirstRefresh = resolve;
    });
    let resolveReconnect!: (value: CoachClient) => void;
    const reconnectGate = new Promise<CoachClient>((resolve) => {
      resolveReconnect = resolve;
    });
    const first = client(async (_request, options) => {
      deliver(options, { type: "text_delta", turnId: "turn-a", delta: "Partial A" });
      throw new CoachClientDisconnectedError(1006, "chat-a-disconnected");
    });
    const recovered = client(async (_request, options) => {
      deliver(options, { type: "final-text", turnId: "turn-b-retry", text: "Recovered B" });
      options?.onTerminalEnvelope?.({
        jsonrpc: "2.0",
        id: 3,
        result: { text: "Recovered B" },
      });
      return { text: "Recovered B" };
    });
    let clientAcquisitions = 0;
    const provider: DesktopCoachClientProvider = {
      getClient: vi.fn(async () => {
        clientAcquisitions += 1;
        if (clientAcquisitions === 1) return first;
        throw new CoachClientDisconnectedError(1006, "chat-b-pre-call-disconnected");
      }),
      reconnect: vi.fn(() => reconnectGate),
      close: vi.fn(async () => {}),
    };
    const states: ChatState[] = [];
    let renderCount = 0;
    let releasedFirstRefresh = false;
    let showSecondInterruption!: () => void;
    const secondInterruption = new Promise<void>((resolve) => {
      showSecondInterruption = resolve;
    });
    const refreshTrainingContext = vi.fn(async () => {
      if (refreshTrainingContext.mock.calls.length === 1) await firstRefreshGate;
    });
    const refreshSpend = vi.fn(async () => {});
    const controller = createChatController({
      clients: provider,
      view: {
        render(state) {
          states.push(structuredClone(state));
          renderCount += 1;
          if (
            !releasedFirstRefresh &&
            state.status === "interrupted" &&
            state.activeTurn?.userMessage === "Chat B"
          ) {
            releasedFirstRefresh = true;
            releaseFirstRefresh();
            showSecondInterruption();
          }
        },
      },
      refreshTrainingContext,
      refreshSpend,
    });

    const chatA = controller.submit("Chat A");
    while (states.at(-1)?.status !== "interrupted") await Promise.resolve();
    const retryA = controller.retryInterrupted();
    const chatB = controller.submit("Chat B");
    await secondInterruption;
    const rendersAtSecondInterruption = renderCount;
    const retryB = controller.retryInterrupted();
    const duplicateB = controller.retryInterrupted();

    expect(retryB).not.toBe(retryA);
    expect(duplicateB).toBe(retryB);
    await Promise.all([chatA, chatB, retryA]);
    expect(provider.getClient).toHaveBeenCalledTimes(2);
    expect(provider.reconnect).toHaveBeenCalledTimes(1);
    expect(renderCount).toBe(rendersAtSecondInterruption + 5);
    expect(first.call).toHaveBeenCalledTimes(1);
    expect(recovered.call).not.toHaveBeenCalled();

    resolveReconnect(recovered);
    await Promise.all([retryB, duplicateB]);

    expect(provider.getClient).toHaveBeenCalledTimes(2);
    expect(provider.reconnect).toHaveBeenCalledTimes(1);
    expect(vi.mocked(first.call).mock.calls.map(([, request]) => request)).toEqual([
      { chatId: "desktop", message: "Chat A" },
    ]);
    expect(vi.mocked(recovered.call).mock.calls.map(([, request]) => request)).toEqual([
      { chatId: "desktop", message: "Chat B" },
    ]);
    expect(refreshTrainingContext).toHaveBeenCalledTimes(2);
    expect(refreshSpend).toHaveBeenCalledTimes(2);
    expect(
      states.at(-1)?.messages.map(({ role, text, delivery }) => ({ role, text, delivery })),
    ).toEqual([
      { role: "athlete", text: "Chat A", delivery: "complete" },
      { role: "coach", text: "Partial A", delivery: "interrupted" },
      { role: "athlete", text: "Chat B", delivery: "complete" },
      { role: "coach", text: "", delivery: "interrupted" },
      { role: "coach", text: "Recovered B", delivery: "complete" },
    ]);
  });

  it("allows one in-flight call and treats client protocol rejection as explicit-retry state", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fake = client(async () => {
      await gate;
      throw new CoachClientProtocolError();
    });
    const { controller, states } = subject(fake);
    const first = controller.submit("One");
    const second = controller.submit("Two");
    await Promise.resolve();
    expect(fake.call).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second]);
    expect(states.at(-1)?.progress).toBe(CHAT_PROTOCOL_FAILURE_COPY);
    expect(states.at(-1)?.messages.at(-1)?.text).toBe("");
  });

  it("does not dispatch blank-only input", async () => {
    const fake = client(async () => ({ text: "unused" }));
    const { controller } = subject(fake);
    await controller.submit("  \n");
    expect(fake.call).not.toHaveBeenCalled();
  });

  it("starts one exact session probe and deduplicates repeated starts", async () => {
    const fake = client(async () => ({ text: "unused" }), {
      hasSession: async () => ({ hasSession: true }),
    });
    const { controller, states } = subject(fake);

    const first = controller.start();
    const duplicate = controller.start();

    expect(duplicate).toBe(first);
    await first;
    expect(vi.mocked(fake.call).mock.calls).toEqual([["hasSession", { chatId: "desktop" }]]);
    expect(states.at(-1)?.session.presence).toBe("present");
  });

  it("keeps reset unavailable after an absent probe and exposes no probe failure", async () => {
    const absent = client(async () => ({ text: "unused" }));
    const first = subject(absent);
    await first.controller.start();
    expect(first.states.at(-1)?.session.presence).toBe("absent");
    expect(first.controls.at(-1)?.newConversationDisabled).toBe(true);
    expect(first.controller.openNewConversation()).toBe(false);
    expect(first.provider.reconnect).not.toHaveBeenCalled();

    const failed = client(async () => ({ text: "unused" }), {
      hasSession: async () => Promise.reject(new Error("private probe detail")),
    });
    const second = subject(failed);
    await second.controller.start();
    expect(second.states.at(-1)?.session).toEqual(EMPTY_CHAT_STATE.session);
    expect(second.provider.reconnect).not.toHaveBeenCalled();
    expect(vi.mocked(failed.call).mock.calls.filter(([method]) => method !== "hasSession")).toEqual(
      [],
    );
  });

  it("uses visible local content without promoting an absent session after pre-client failure", async () => {
    const fake = client(async () => ({ text: "unused" }));
    const { controller, provider, states, controls } = subject(fake);
    await controller.start();

    let rejectClient!: (reason?: unknown) => void;
    const clientGate = new Promise<CoachClient>((_resolve, reject) => {
      rejectClient = reject;
    });
    vi.mocked(provider.getClient).mockReturnValueOnce(clientGate);

    const submission = controller.submit("Keep this visible");
    expect(states.at(-1)?.session.presence).toBe("absent");
    expect(states.at(-1)?.messages).toMatchObject([
      { role: "athlete", text: "Keep this visible" },
      { role: "coach", text: "" },
    ]);
    expect(controls.at(-1)?.newConversationDisabled).toBe(true);
    expect(controller.openNewConversation()).toBe(false);

    rejectClient(new Error("synthetic pre-client failure"));
    await submission;

    expect(states.at(-1)?.session.presence).toBe("absent");
    expect(states.at(-1)?.messages).toMatchObject([
      { role: "athlete", text: "Keep this visible", delivery: "complete" },
      { role: "coach", text: "", delivery: "interrupted" },
    ]);
    expect(
      controls.slice(-2).map(({ newConversationDisabled }) => newConversationDisabled),
    ).toEqual([true, false]);
    expect(controller.openNewConversation()).toBe(true);
    expect(states.at(-1)?.session).toMatchObject({
      presence: "absent",
      resetPhase: "confirming",
    });
    expect(vi.mocked(fake.call).mock.calls.filter(([method]) => method === "chat")).toEqual([]);

    await controller.confirmNewConversation();
    expect(states.at(-1)?.messages).toEqual([]);
    expect(states.at(-1)?.session).toMatchObject({
      presence: "absent",
      resetPhase: "idle",
    });
    expect(vi.mocked(fake.call).mock.calls.filter(([method]) => method === "resetSession")).toEqual(
      [["resetSession", { chatId: "desktop" }]],
    );
  });

  it("ignores a delayed false probe after a locally completed chat", async () => {
    let resolveProbe!: (value: { hasSession: boolean }) => void;
    const probe = new Promise<{ hasSession: boolean }>((resolve) => {
      resolveProbe = resolve;
    });
    const fake = client(
      async (_request, options) => {
        deliver(options, { type: "final-text", turnId: "turn-1", text: "Done" });
        options?.onTerminalEnvelope?.({ jsonrpc: "2.0", id: 1, result: { text: "Done" } });
        return { text: "Done" };
      },
      { hasSession: async () => probe },
    );
    const { controller, states } = subject(fake);

    const starting = controller.start();
    await controller.submit("Continue");
    resolveProbe({ hasSession: false });
    await starting;

    expect(states.at(-1)?.session.presence).toBe("present");
    expect(controller.openNewConversation()).toBe(true);
  });

  it("ignores a delayed true probe after a successful reset", async () => {
    let resolveProbe!: (value: { hasSession: boolean }) => void;
    const probe = new Promise<{ hasSession: boolean }>((resolve) => {
      resolveProbe = resolve;
    });
    const fake = client(
      async (_request, options) => {
        deliver(options, { type: "final-text", turnId: "turn-1", text: "Done" });
        options?.onTerminalEnvelope?.({ jsonrpc: "2.0", id: 1, result: { text: "Done" } });
        return { text: "Done" };
      },
      {
        hasSession: async () => probe,
        resetSession: async () => ({ memoryFlushed: true }),
      },
    );
    const { controller, states } = subject(fake);

    const starting = controller.start();
    await controller.submit("Continue");
    expect(controller.openNewConversation()).toBe(true);
    await controller.confirmNewConversation();
    resolveProbe({ hasSession: true });
    await starting;

    expect(states.at(-1)?.session.presence).toBe("absent");
    expect(states.at(-1)?.messages).toEqual([]);
    expect(controller.openNewConversation()).toBe(false);
  });

  it("rejects confirmation while chat streaming or terminal refresh is active", async () => {
    let releaseChat!: () => void;
    const chatGate = new Promise<void>((resolve) => {
      releaseChat = resolve;
    });
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const fake = client(async (_request, options) => {
      await chatGate;
      deliver(options, { type: "final-text", turnId: "turn-1", text: "Done" });
      options?.onTerminalEnvelope?.({ jsonrpc: "2.0", id: 1, result: { text: "Done" } });
      return { text: "Done" };
    });
    const { controller, refresh } = subject(fake, fake, () => refreshGate);

    const submission = controller.submit("Continue");
    await Promise.resolve();
    expect(controller.openNewConversation()).toBe(false);
    releaseChat();
    while (refresh.mock.calls.length === 0) await Promise.resolve();
    expect(controller.openNewConversation()).toBe(false);
    releaseRefresh();
    await submission;
    expect(controller.openNewConversation()).toBe(true);
  });

  it("keeps reset unavailable until every accepted chat cleanup settles", async () => {
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const fake = client(async (_request, options) => {
      deliver(options, { type: "final-text", turnId: "turn-1", text: "Done" });
      options?.onTerminalEnvelope?.({ jsonrpc: "2.0", id: 1, result: { text: "Done" } });
      return { text: "Done" };
    });
    const { controller, provider, states, controls, refresh } = subject(
      fake,
      fake,
      () => refreshGate,
    );

    const chatA = controller.submit("Chat A");
    while (refresh.mock.calls.length === 0) await Promise.resolve();
    expect(states.at(-1)?.status).toBe("idle");

    vi.mocked(provider.getClient).mockRejectedValueOnce(new Error("synthetic admission failure"));
    const chatB = controller.submit("Chat B");
    await chatB;

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(controls.at(-1)?.newConversationDisabled).toBe(true);
    expect(controller.openNewConversation()).toBe(false);
    expect(vi.mocked(fake.call).mock.calls.filter(([method]) => method === "resetSession")).toEqual(
      [],
    );

    releaseRefresh();
    await chatA;

    expect(controls.at(-1)?.newConversationDisabled).toBe(false);
    expect(controller.openNewConversation()).toBe(true);
    expect(vi.mocked(fake.call).mock.calls.filter(([method]) => method === "resetSession")).toEqual(
      [],
    );
  });

  it("blocks submit and retry while confirmation is open, then cancel permits retry", async () => {
    const interrupted = client(async (_request, options) => {
      deliver(options, { type: "text_delta", turnId: "turn-1", delta: "Partial" });
      throw new CoachClientDisconnectedError(1006, "synthetic");
    });
    const recovered = client(async (_request, options) => {
      deliver(options, { type: "final-text", turnId: "turn-2", text: "Recovered" });
      options?.onTerminalEnvelope?.({ jsonrpc: "2.0", id: 2, result: { text: "Recovered" } });
      return { text: "Recovered" };
    });
    const { controller } = subject(interrupted, recovered);
    await controller.submit("Original");
    expect(controller.openNewConversation()).toBe(true);
    vi.mocked(interrupted.call).mockClear();

    await Promise.all([controller.submit("Blocked"), controller.retryInterrupted()]);
    expect(interrupted.call).not.toHaveBeenCalled();
    expect(recovered.call).not.toHaveBeenCalled();

    controller.cancelNewConversation();
    expect(controller.openNewConversation()).toBe(true);
    controller.cancelNewConversation();
    await controller.retryInterrupted();
    expect(recovered.call).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(interrupted.call).mock.calls.filter(([method]) => method === "resetSession"),
    ).toEqual([]);
  });

  it.each([
    [true, NEW_CONVERSATION_SUCCESS_COPY],
    [false, NEW_CONVERSATION_MEMORY_WARNING_COPY],
  ] as const)(
    "clears only after reset success when memoryFlushed is %s",
    async (memoryFlushed, announcement) => {
      let settleReset!: (value: { memoryFlushed: boolean }) => void;
      const resetGate = new Promise<{ memoryFlushed: boolean }>((resolve) => {
        settleReset = resolve;
      });
      const fake = client(
        async (_request, options) => {
          deliver(options, { type: "final-text", turnId: "turn-1", text: "Done" });
          options?.onTerminalEnvelope?.({ jsonrpc: "2.0", id: 1, result: { text: "Done" } });
          return { text: "Done" };
        },
        { resetSession: async () => resetGate },
      );
      const { controller, states, refreshSpend } = subject(fake);
      await controller.submit("Original");
      const transcript = states.at(-1)?.messages;
      refreshSpend.mockClear();
      expect(controller.openNewConversation()).toBe(true);

      const first = controller.confirmNewConversation();
      const duplicate = controller.confirmNewConversation();
      expect(duplicate).toBe(first);
      await Promise.resolve();
      expect(
        vi.mocked(fake.call).mock.calls.filter(([method]) => method === "resetSession"),
      ).toEqual([["resetSession", { chatId: "desktop" }]]);
      expect(states.at(-1)?.messages).toEqual(transcript);
      expect(states.at(-1)?.session.resetPhase).toBe("resetting");

      settleReset({ memoryFlushed });
      await first;
      expect(states.at(-1)).toMatchObject({
        status: "idle",
        messages: [],
        activeTurn: null,
        progress: null,
        session: {
          presence: "absent",
          resetPhase: "idle",
          announcement,
        },
      });
      expect(refreshSpend).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    new Error("private reset detail"),
    new CoachClientCallTimeoutError("resetSession", 660_000),
    new CoachClientDisconnectedError(1006, "synthetic"),
    new CoachClientProtocolError(),
  ])("preserves conversation and blocks a second reset after $name", async (failure) => {
    const fake = client(
      async (_request, options) => {
        deliver(options, { type: "final-text", turnId: "turn-1", text: "Done" });
        options?.onTerminalEnvelope?.({ jsonrpc: "2.0", id: 1, result: { text: "Done" } });
        return { text: "Done" };
      },
      { resetSession: async () => Promise.reject(failure) },
    );
    const { controller, states } = subject(fake);
    await controller.submit("Original");
    const before = structuredClone(states.at(-1)!);
    expect(controller.openNewConversation()).toBe(true);
    await controller.confirmNewConversation();

    expect(states.at(-1)).toMatchObject({
      status: before.status,
      messages: before.messages,
      activeTurn: before.activeTurn,
      progress: before.progress,
      session: {
        presence: "present",
        resetPhase: "uncertain",
        announcement: NEW_CONVERSATION_UNCERTAIN_COPY,
      },
    });
    expect(controller.openNewConversation()).toBe(false);
    await controller.confirmNewConversation();
    expect(
      vi.mocked(fake.call).mock.calls.filter(([method]) => method === "resetSession"),
    ).toHaveLength(1);
    expect(
      vi.mocked(fake.call).mock.calls.filter(([method]) => method === "hasSession"),
    ).toHaveLength(0);
  });

  it("preserves interrupted retry ownership after an uncertain reset", async () => {
    const interrupted = client(
      async (_request, options) => {
        deliver(options, { type: "text_delta", turnId: "turn-1", delta: "Partial" });
        throw new CoachClientDisconnectedError(1006, "synthetic");
      },
      { resetSession: async () => Promise.reject(new Error("uncertain")) },
    );
    const recovered = client(async (_request, options) => {
      deliver(options, { type: "final-text", turnId: "turn-2", text: "Recovered" });
      options?.onTerminalEnvelope?.({ jsonrpc: "2.0", id: 2, result: { text: "Recovered" } });
      return { text: "Recovered" };
    });
    const { controller, provider, states } = subject(interrupted, recovered);
    await controller.submit("Original");
    expect(controller.openNewConversation()).toBe(true);
    await controller.confirmNewConversation();
    await controller.retryInterrupted();

    expect(provider.reconnect).toHaveBeenCalledTimes(1);
    expect(states.at(-1)?.messages.at(-1)?.text).toBe("Recovered");
  });

  it("holds one reset pending while repeated confirm, submit, and retry dispatch no chat", async () => {
    let settleReset!: (value: { memoryFlushed: boolean }) => void;
    const resetGate = new Promise<{ memoryFlushed: boolean }>((resolve) => {
      settleReset = resolve;
    });
    const fake = client(
      async (_request, options) => {
        deliver(options, { type: "text_delta", turnId: "turn-1", delta: "Partial" });
        throw new CoachClientDisconnectedError(1006, "synthetic");
      },
      { resetSession: async () => resetGate },
    );
    const { controller } = subject(fake);
    await controller.submit("Original");
    expect(controller.openNewConversation()).toBe(true);
    vi.mocked(fake.call).mockClear();

    const reset = controller.confirmNewConversation();
    const duplicate = controller.confirmNewConversation();
    await Promise.all([controller.submit("Blocked"), controller.retryInterrupted()]);
    await Promise.resolve();

    expect(duplicate).toBe(reset);
    expect(vi.mocked(fake.call).mock.calls).toEqual([["resetSession", { chatId: "desktop" }]]);
    settleReset({ memoryFlushed: true });
    await reset;
    expect(vi.mocked(fake.call).mock.calls.filter(([method]) => method === "chat")).toEqual([]);
  });

  it("queues a message sent while the coach streams and dispatches it once the turn settles", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fake = client(replies(() => gate));
    const { controller, states } = subject(fake);

    const submission = controller.submit("First question");
    await expect(controller.submit("Second question")).resolves.toBeUndefined();

    expect(chatMessages(fake)).toEqual(["First question"]);
    expect(states.at(-1)?.queued).toMatchObject([{ text: "Second question", command: false }]);
    expect(states.at(-1)?.status).toBe("streaming");

    release();
    await submission;

    expect(chatMessages(fake)).toEqual(["First question", "Second question"]);
    expect(states.at(-1)?.queued).toEqual([]);
    expect(states.at(-1)?.status).toBe("idle");
    expect(states.at(-1)?.messages.map((message) => message.text)).toEqual([
      "First question",
      "Reply 1",
      "Second question",
      "Reply 2",
    ]);
  });

  it("coalesces queued free text into one turn and keeps each command on its own turn", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fake = client(replies(() => gate));
    const { controller } = subject(fake);

    const submission = controller.submit("Opening");
    await Promise.all([
      controller.submit("One more thought"),
      controller.submit("And another"),
      controller.submit("/plan"),
      controller.submit("Back to prose"),
    ]);

    release();
    await submission;

    expect(chatMessages(fake)).toEqual([
      "Opening",
      "One more thought\n\nAnd another",
      "/plan",
      "Back to prose",
    ]);
  });

  it("holds the queue when the streaming turn is interrupted and drains after a successful retry", async () => {
    const recovered = client(replies());
    let current: CoachClient;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const failing = client(async (_request, options) => {
      deliver(options, { type: "text_delta", turnId: "turn-1", delta: "Partial" });
      await gate;
      throw new CoachClientDisconnectedError(1006, "synthetic");
    });
    current = failing;
    const provider: DesktopCoachClientProvider = {
      getClient: vi.fn(async () => current),
      reconnect: vi.fn(async () => {
        current = recovered;
        return recovered;
      }),
      close: vi.fn(async () => {}),
    };
    const states: ChatState[] = [];
    const controller = createChatController({
      clients: provider,
      view: { render: (state) => states.push(structuredClone(state)) },
      refreshTrainingContext: vi.fn(async () => {}),
      refreshSpend: vi.fn(async () => {}),
    });

    const submission = controller.submit("Original");
    await controller.submit("Queued behind it");
    release();
    await submission;

    expect(states.at(-1)?.status).toBe("interrupted");
    expect(states.at(-1)?.queued).toMatchObject([{ text: "Queued behind it" }]);
    expect(chatMessages(recovered)).toEqual([]);
    expect(controller.openNewConversation()).toBe(false);

    await controller.retryInterrupted();

    expect(chatMessages(recovered)).toEqual(["Original", "Queued behind it"]);
    expect(states.at(-1)?.queued).toEqual([]);
  });

  it("keeps a queued message un-drained after a failed turn and removes it on request", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fake = client(async () => {
      await gate;
      throw new Error("private failure detail");
    });
    const { controller, states } = subject(fake);

    const submission = controller.submit("Original");
    await controller.submit("Queued behind it");
    release();
    await submission;

    expect(states.at(-1)).toMatchObject({ status: "idle", progress: CHAT_FAILURE_COPY });
    expect(chatMessages(fake)).toEqual(["Original"]);
    const held = states.at(-1)?.queued.at(0)?.id;
    expect(held).toBeDefined();
    expect(controller.openNewConversation()).toBe(false);

    controller.removeQueued(held ?? "");

    expect(states.at(-1)?.queued).toEqual([]);
    expect(chatMessages(fake)).toEqual(["Original"]);
    expect(controller.openNewConversation()).toBe(true);
  });

  it("drains a queue left over from a paused turn when the athlete sends again", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const fake = client(async (request, options) => {
      calls += 1;
      if (calls === 1) {
        await gate;
        throw new Error("private failure detail");
      }
      return replies()(request, options);
    });
    const { controller, states } = subject(fake);

    const submission = controller.submit("Original");
    await controller.submit("Queued behind it");
    release();
    await submission;
    expect(chatMessages(fake)).toEqual(["Original"]);

    await controller.submit("Sent after the failure");

    expect(chatMessages(fake)).toEqual(["Original", "Queued behind it\n\nSent after the failure"]);
    expect(states.at(-1)?.queued).toEqual([]);
  });

  it("holds the queue when a drain lands while a newer turn is already streaming", async () => {
    const releaseCall: Record<number, () => void> = {};
    const callGates: Record<number, Promise<void>> = {};
    for (const turnNumber of [1, 2]) {
      callGates[turnNumber] = new Promise<void>((resolve) => {
        releaseCall[turnNumber] = resolve;
      });
    }
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    let refreshes = 0;
    let turn = 0;
    const fake = client(async (_request, options) => {
      turn += 1;
      const gate = callGates[turn];
      if (gate !== undefined) await gate;
      const text = `Reply ${turn}`;
      deliver(options, { type: "final-text", turnId: `turn-${turn}`, text });
      options?.onTerminalEnvelope?.({ jsonrpc: "2.0", id: turn, result: { text } });
      return { text };
    });
    const { controller, states } = subject(fake, fake, () => {
      refreshes += 1;
      return refreshes === 1 ? refreshGate : Promise.resolve();
    });

    const submission = controller.submit("Original");
    await controller.submit("Queued prose");
    await controller.submit("/plan");

    releaseCall[1]?.();
    while (states.at(-1)?.status !== "idle") await Promise.resolve();

    const late = controller.submit("Sent in the refresh window");
    while (chatMessages(fake).length < 2) await Promise.resolve();

    expect(states.at(-1)?.status).toBe("streaming");
    expect(chatMessages(fake)).toEqual(["Original", "Queued prose"]);
    expect(states.at(-1)?.queued).toMatchObject([
      { text: "/plan" },
      { text: "Sent in the refresh window" },
    ]);

    releaseRefresh();
    await submission;

    expect(chatMessages(fake)).toEqual(["Original", "Queued prose"]);
    expect(states.at(-1)?.queued).toMatchObject([
      { text: "/plan" },
      { text: "Sent in the refresh window" },
    ]);

    releaseCall[2]?.();
    await late;

    expect(chatMessages(fake)).toEqual([
      "Original",
      "Queued prose",
      "/plan",
      "Sent in the refresh window",
    ]);
    expect(states.at(-1)?.queued).toEqual([]);
    expect(states.at(-1)?.status).toBe("idle");
    expect(
      states
        .at(-1)
        ?.messages.filter((message) => message.role === "athlete")
        .map((message) => message.text),
    ).toEqual(["Original", "Queued prose", "/plan", "Sent in the refresh window"]);
  });

  it("never drains a queued message after dispose", async () => {
    let release!: () => void;
    const refreshGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fake = client(replies());
    const { controller, provider, states } = subject(fake, fake, () => refreshGate);

    const submission = controller.submit("Original");
    await controller.submit("Queued behind it");
    while (states.at(-1)?.status !== "idle") await Promise.resolve();
    const renderCount = states.length;
    controller.dispose();
    release();
    await submission;

    expect(states).toHaveLength(renderCount);
    expect(states.at(-1)?.queued).toMatchObject([{ text: "Queued behind it" }]);
    expect(chatMessages(fake)).toEqual(["Original"]);
    expect(provider.getClient).toHaveBeenCalledTimes(1);
  });

  it("fences late probe and reset settlements after dispose without refreshing spend", async () => {
    let settleProbe!: (value: { hasSession: boolean }) => void;
    let settleReset!: (value: { memoryFlushed: boolean }) => void;
    const probeGate = new Promise<{ hasSession: boolean }>((resolve) => {
      settleProbe = resolve;
    });
    const resetGate = new Promise<{ memoryFlushed: boolean }>((resolve) => {
      settleReset = resolve;
    });
    const fake = client(
      async (_request, options) => {
        deliver(options, { type: "final-text", turnId: "turn-1", text: "Done" });
        options?.onTerminalEnvelope?.({ jsonrpc: "2.0", id: 1, result: { text: "Done" } });
        return { text: "Done" };
      },
      {
        hasSession: async () => probeGate,
        resetSession: async () => resetGate,
      },
    );
    const { controller, states, refreshSpend } = subject(fake);
    const starting = controller.start();
    await controller.submit("Original");
    expect(controller.openNewConversation()).toBe(true);
    refreshSpend.mockClear();
    const resetting = controller.confirmNewConversation();
    await Promise.resolve();
    const renderCount = states.length;
    controller.dispose();

    settleProbe({ hasSession: true });
    settleReset({ memoryFlushed: true });
    await Promise.all([starting, resetting]);

    expect(states).toHaveLength(renderCount);
    expect(refreshSpend).not.toHaveBeenCalled();
    expect(
      vi.mocked(fake.call).mock.calls.filter(([method]) => method === "hasSession"),
    ).toHaveLength(1);
    expect(
      vi.mocked(fake.call).mock.calls.filter(([method]) => method === "resetSession"),
    ).toHaveLength(1);
  });
});
