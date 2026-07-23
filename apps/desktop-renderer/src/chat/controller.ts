import type { CoachClient, CoachClientTerminalEnvelope } from "@enduragent/coach-client";
import {
  CoachClientCallAbortedError,
  CoachClientCallTimeoutError,
  CoachClientDisconnectedError,
  CoachClientProtocolError,
} from "@enduragent/coach-client";
import type { CoachTurnEventNotificationEnvelope, TurnEvent } from "@enduragent/coach-contract";
import type { DesktopCoachClientProvider } from "../coach-client.js";
import {
  DESKTOP_CHAT_ID,
  EMPTY_CHAT_STATE,
  hasClearableConversation,
  reduceChatState,
  type ChatState,
} from "../turn-state.js";
import { COACH_RESPONSE_CODE_UNIT_LIMIT, COACH_TURN_EVENT_LIMIT } from "./limits.js";

export const CHAT_CONNECTION_INTERRUPTED_COPY =
  "Connection interrupted. Your partial response is preserved.";
export const CHAT_PROTOCOL_FAILURE_COPY =
  "The coaching response could not be verified. Please try again.";
export const CHAT_FAILURE_COPY = "The coach couldn't respond. Please try again.";
export const CHAT_EMPTY_RESPONSE_COPY = "The coach returned an empty response. Please try again.";
export const NEW_CONVERSATION_SUCCESS_COPY = "New conversation started.";
export const NEW_CONVERSATION_MEMORY_WARNING_COPY =
  "New conversation started. Some recent details may not have been saved to coach memory.";
export const NEW_CONVERSATION_UNCERTAIN_COPY =
  "We couldn’t confirm whether the new conversation started. Your visible conversation is preserved.";

export interface ChatAppendDelta {
  readonly messageId: string;
  readonly previousTextLength: number;
  readonly nextTextLength: number;
  readonly delta: string;
}

export interface ChatViewControls {
  readonly newConversationDisabled: boolean;
  readonly workBlocked: boolean;
  readonly appendDelta?: ChatAppendDelta;
}

export interface ChatView {
  render(state: ChatState, controls?: ChatViewControls): void;
}

export interface ChatController {
  start(): Promise<void>;
  submit(message: string): Promise<void>;
  retryInterrupted(): Promise<void>;
  openNewConversation(): boolean;
  cancelNewConversation(): void;
  confirmNewConversation(): Promise<void>;
  dispose(): void;
}

interface QueuedRetry {
  readonly requestKey: number;
  readonly promise: Promise<void>;
  readonly token: object;
}

export function createChatController(input: {
  readonly clients: DesktopCoachClientProvider;
  readonly view: ChatView;
  readonly refreshTrainingContext: () => Promise<void>;
  readonly refreshSpend: () => Promise<void>;
}): ChatController {
  let state = EMPTY_CHAT_STATE;
  let sequence = 0;
  let disposed = false;
  let activeTask: Promise<void> | undefined;
  const outstandingChatTasks = new Set<Promise<void>>();
  let queuedRetry: QueuedRetry | undefined;
  let retryClient: CoachClient | undefined;
  let probeTask: Promise<void> | undefined;
  let resetTask: Promise<void> | undefined;
  let epoch = 0;

  const nextId = (prefix: "request" | "message"): string => `${prefix}-${++sequence}`;
  const resetBlocksWork = (): boolean =>
    state.session.resetPhase === "confirming" || state.session.resetPhase === "resetting";
  const canOpenNewConversation = (): boolean =>
    !disposed &&
    hasClearableConversation(state) &&
    state.session.resetPhase === "idle" &&
    state.status !== "streaming" &&
    activeTask === undefined &&
    outstandingChatTasks.size === 0 &&
    queuedRetry === undefined &&
    resetTask === undefined;
  const render = (appendDelta?: ChatAppendDelta): void => {
    if (disposed) return;
    try {
      input.view.render(state, {
        newConversationDisabled: !canOpenNewConversation(),
        workBlocked: resetBlocksWork(),
        ...(appendDelta === undefined ? {} : { appendDelta }),
      });
    } catch {}
  };
  const reduce = (
    action: Parameters<typeof reduceChatState>[1],
    appendDelta?: ChatAppendDelta,
  ): void => {
    state = reduceChatState(state, action);
    render(appendDelta);
  };

  const run = (userMessage: string, includeUser: boolean, reconnect: boolean): Promise<void> => {
    epoch += 1;
    const requestKey = Number(nextId("request").slice("request-".length));
    const userMessageId = nextId("message");
    const assistantMessageId = nextId("message");
    reduce({
      type: "submit",
      requestKey,
      userMessage,
      userMessageId,
      assistantMessageId,
      includeUser,
    });
    let callStarted = false;
    const task = (async () => {
      let boundRequestId: string | number | undefined;
      let boundTurnId: string | undefined;
      let pendingEnvelope: CoachTurnEventNotificationEnvelope | undefined;
      let eventCount = 0;
      let startSeen = false;
      let finalText: string | undefined;
      let terminal: CoachClientTerminalEnvelope | undefined;
      let terminalHadFinal = false;
      let protocolFault = false;
      const callAbortController = new AbortController();
      const current = (): boolean => !disposed && state.activeTurn?.requestKey === requestKey;
      const failProtocol = (): void => {
        if (protocolFault) return;
        protocolFault = true;
        callAbortController.abort();
      };

      let client: CoachClient | undefined;
      try {
        if (reconnect) {
          if (retryClient === undefined) {
            client = await input.clients.reconnect();
          } else {
            const currentClient = await input.clients.getClient();
            client =
              currentClient === retryClient ? await input.clients.reconnect() : currentClient;
          }
          retryClient = undefined;
        } else {
          client = await input.clients.getClient();
        }
        if (!current()) return;
        callStarted = true;
        const result = await client.call(
          "chat",
          { chatId: DESKTOP_CHAT_ID, message: userMessage },
          {
            signal: callAbortController.signal,
            onNotificationEnvelope(envelope) {
              if (!current() || protocolFault) return;
              if (
                envelope.method !== "coach.turnEvent" ||
                envelope.params.requestMethod !== "chat" ||
                envelope.params.turnId.length === 0
              ) {
                failProtocol();
                return;
              }
              if (boundRequestId === undefined) {
                boundRequestId = envelope.params.requestId;
                boundTurnId = envelope.params.turnId;
                reduce({ type: "bind-turn", requestKey, turnId: boundTurnId });
              } else if (
                envelope.params.requestId !== boundRequestId ||
                envelope.params.turnId !== boundTurnId
              ) {
                failProtocol();
                return;
              }
              pendingEnvelope = envelope;
            },
            onEvent(event: TurnEvent) {
              if (!current() || protocolFault) return;
              const envelope = pendingEnvelope;
              pendingEnvelope = undefined;
              if (
                envelope === undefined ||
                boundTurnId === undefined ||
                event.turnId !== boundTurnId ||
                envelope.params.event.turnId !== boundTurnId
              ) {
                failProtocol();
                return;
              }
              if (eventCount >= COACH_TURN_EVENT_LIMIT) {
                failProtocol();
                return;
              }
              eventCount += 1;
              if (event.type === "turn-start") {
                if (eventCount !== 1 || startSeen || event.chatId !== DESKTOP_CHAT_ID) {
                  failProtocol();
                  return;
                }
                startSeen = true;
              }
              let appendDelta: ChatAppendDelta | undefined;
              if (event.type === "text_delta") {
                const activeTurn = state.activeTurn;
                if (activeTurn === null || activeTurn.requestKey !== requestKey) return;
                const previousTextLength = activeTurn.draft.length;
                if (event.delta.length > COACH_RESPONSE_CODE_UNIT_LIMIT - previousTextLength) {
                  failProtocol();
                  return;
                }
                appendDelta = {
                  messageId: activeTurn.assistantMessageId,
                  previousTextLength,
                  nextTextLength: previousTextLength + event.delta.length,
                  delta: event.delta,
                };
              } else if (
                event.type === "final-text" &&
                event.text.length > COACH_RESPONSE_CODE_UNIT_LIMIT
              ) {
                failProtocol();
                return;
              }
              if (event.type === "final-text") finalText = event.text;
              reduce({ type: "event", requestKey, event }, appendDelta);
            },
            onTerminalEnvelope(envelope) {
              if (!current()) return;
              terminal = envelope;
              terminalHadFinal = finalText !== undefined;
            },
          },
        );
        if (!current()) return;
        if (
          protocolFault ||
          terminal === undefined ||
          !("result" in terminal) ||
          !terminalHadFinal ||
          finalText === undefined ||
          result.text !== finalText
        ) {
          retryClient = client;
          reduce({ type: "interrupt", requestKey, copy: CHAT_PROTOCOL_FAILURE_COPY });
          return;
        }
        if (!/\S/u.test(finalText)) {
          retryClient = client;
          reduce({ type: "interrupt", requestKey, copy: CHAT_EMPTY_RESPONSE_COPY });
          return;
        }
        reduce({ type: "complete", requestKey });
      } catch (error) {
        if (!current()) return;
        if (protocolFault || error instanceof CoachClientProtocolError) {
          retryClient = client;
          reduce({ type: "interrupt", requestKey, copy: CHAT_PROTOCOL_FAILURE_COPY });
        } else if (
          error instanceof CoachClientDisconnectedError ||
          error instanceof CoachClientCallTimeoutError ||
          error instanceof CoachClientCallAbortedError
        ) {
          retryClient = client;
          reduce({ type: "interrupt", requestKey, copy: CHAT_CONNECTION_INTERRUPTED_COPY });
        } else {
          reduce({ type: "fail", requestKey, copy: CHAT_FAILURE_COPY });
        }
      } finally {
        if (callStarted) {
          try {
            void input.refreshSpend().catch(() => {});
          } catch {}
          try {
            await input.refreshTrainingContext();
          } catch {}
        }
      }
    })();
    activeTask = task;
    outstandingChatTasks.add(task);
    render();
    void task.finally(() => {
      const released = outstandingChatTasks.delete(task);
      if (activeTask === task) {
        activeTask = undefined;
      }
      if (released) render();
    });
    return task;
  };

  render();
  return {
    start() {
      if (probeTask !== undefined) return probeTask;
      const probeEpoch = epoch;
      const task = (async () => {
        try {
          const client = await input.clients.getClient();
          const result = await client.call("hasSession", { chatId: DESKTOP_CHAT_ID });
          if (disposed || epoch !== probeEpoch) return;
          reduce({ type: "session-probe", hasSession: result.hasSession });
        } catch {}
      })();
      probeTask = task;
      return task;
    },
    submit(message) {
      if (!/\S/u.test(message) || disposed || state.status === "streaming" || resetBlocksWork()) {
        return activeTask ?? Promise.resolve();
      }
      return run(message, true, false);
    },
    retryInterrupted() {
      if (
        disposed ||
        state.status !== "interrupted" ||
        state.activeTurn === null ||
        resetBlocksWork()
      ) {
        return activeTask ?? Promise.resolve();
      }
      const { requestKey, userMessage } = state.activeTurn;
      if (queuedRetry?.requestKey === requestKey) return queuedRetry.promise;
      if (activeTask === undefined) return run(userMessage, false, true);
      const currentTask = activeTask;
      const token = {};
      const pending = currentTask
        .then(() => {
          if (
            disposed ||
            state.status !== "interrupted" ||
            state.activeTurn?.requestKey !== requestKey
          ) {
            return;
          }
          return run(userMessage, false, true);
        })
        .finally(() => {
          if (queuedRetry?.token === token) {
            queuedRetry = undefined;
            render();
          }
        });
      queuedRetry = { requestKey, promise: pending, token };
      reduce({ type: "retry-pending", requestKey });
      return pending;
    },
    openNewConversation() {
      if (!canOpenNewConversation()) return false;
      epoch += 1;
      reduce({ type: "open-new-conversation" });
      return true;
    },
    cancelNewConversation() {
      if (disposed || state.session.resetPhase !== "confirming") return;
      reduce({ type: "cancel-new-conversation" });
    },
    confirmNewConversation() {
      if (resetTask !== undefined) return resetTask;
      if (disposed || state.session.resetPhase !== "confirming") return Promise.resolve();
      reduce({ type: "begin-reset" });
      const resetEpoch = ++epoch;
      const task = (async () => {
        try {
          const client = await input.clients.getClient();
          const result = await client.call("resetSession", { chatId: DESKTOP_CHAT_ID });
          if (disposed || epoch !== resetEpoch) return;
          sequence += 1;
          retryClient = undefined;
          queuedRetry = undefined;
          reduce({
            type: "reset-succeeded",
            announcement: result.memoryFlushed
              ? NEW_CONVERSATION_SUCCESS_COPY
              : NEW_CONVERSATION_MEMORY_WARNING_COPY,
          });
        } catch {
          if (disposed || epoch !== resetEpoch) return;
          reduce({ type: "reset-failed", announcement: NEW_CONVERSATION_UNCERTAIN_COPY });
        } finally {
          if (!disposed && epoch === resetEpoch) {
            try {
              void input.refreshSpend().catch(() => {});
            } catch {}
          }
        }
      })();
      resetTask = task;
      void task.finally(() => {
        if (resetTask === task) {
          resetTask = undefined;
          render();
        }
      });
      return task;
    },
    dispose() {
      disposed = true;
      epoch += 1;
      sequence += 1;
    },
  };
}
