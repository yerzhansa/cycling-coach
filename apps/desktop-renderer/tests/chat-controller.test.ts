import { describe, expect, it, vi } from "vitest";
import {
  CoachClientDisconnectedError,
  CoachClientProtocolError,
  type CoachClient,
  type CoachClientCallOptions,
} from "@enduragent/coach-client";
import type { CoachTurnEventNotificationEnvelope, TurnEvent } from "@enduragent/coach-contract";
import {
  CHAT_CONNECTION_INTERRUPTED_COPY,
  CHAT_PROTOCOL_FAILURE_COPY,
  createChatController,
} from "../src/chat/controller.js";
import type { DesktopCoachClientProvider } from "../src/coach-client.js";
import type { ChatState } from "../src/turn-state.js";

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

function errorEvent(message = "Safe athlete message"): TurnEvent {
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

function client(
  implementation: (
    request: { chatId: string; message: string },
    options: CoachClientCallOptions<"chat"> | undefined,
  ) => Promise<{ text: string }>,
): CoachClient {
  return {
    handshake: {} as CoachClient["handshake"],
    call: vi.fn((method, request, options) => {
      if (method !== "chat") throw new TypeError();
      return implementation(
        request as { chatId: string; message: string },
        options as CoachClientCallOptions<"chat">,
      ) as never;
    }),
    close: vi.fn(async () => {}),
  };
}

function subject(
  first: CoachClient,
  reconnected: CoachClient = first,
  refreshImplementation: () => Promise<void> = async () => {},
  spendRefreshImplementation: () => Promise<void> = async () => {},
) {
  const states: ChatState[] = [];
  const refresh = vi.fn(refreshImplementation);
  const refreshSpend = vi.fn(spendRefreshImplementation);
  const provider: DesktopCoachClientProvider = {
    getClient: vi.fn(async () => first),
    reconnect: vi.fn(async () => reconnected),
    close: vi.fn(async () => {}),
  };
  const controller = createChatController({
    clients: provider,
    view: { render: (state) => states.push(structuredClone(state)) },
    refreshTrainingContext: refresh,
    refreshSpend,
  });
  return { controller, provider, states, refresh, refreshSpend };
}

describe("chat controller", () => {
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
    expect(vi.mocked(fake.call).mock.calls[0]?.slice(0, 2)).toEqual([
      "chat",
      { chatId: "desktop", message: "Original message " },
    ]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refreshSpend).toHaveBeenCalledTimes(1);
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
    await controller.retryInterrupted();
    expect(provider.reconnect).toHaveBeenCalledTimes(1);
    expect(vi.mocked(second.call).mock.calls[0]?.[1]).toEqual({
      chatId: "desktop",
      message: "Same message",
    });
    expect(states.at(-1)?.messages.filter((message) => message.role === "athlete")).toHaveLength(1);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

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
    const controller = createChatController({
      clients: provider,
      view: {
        render(state) {
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
    release();
    await Promise.all([submission, retry, duplicate]);
    expect(provider.reconnect).toHaveBeenCalledTimes(1);
    expect(second.call).toHaveBeenCalledTimes(1);
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
});
