import type { CoachClient, CoachClientTerminalEnvelope } from "@enduragent/coach-client";
import { CoachClientDisconnectedError, CoachClientProtocolError } from "@enduragent/coach-client";
import type { CoachTurnEventNotificationEnvelope, TurnEvent } from "@enduragent/coach-contract";
import type { DesktopCoachClientProvider } from "../coach-client.js";
import {
  DESKTOP_CHAT_ID,
  EMPTY_CHAT_STATE,
  reduceChatState,
  type ChatState,
} from "../turn-state.js";

export const CHAT_CONNECTION_INTERRUPTED_COPY =
  "Connection interrupted. Your partial response is preserved.";
export const CHAT_PROTOCOL_FAILURE_COPY =
  "The coaching response could not be verified. Please try again.";
export const CHAT_FAILURE_COPY = "The coach couldn't respond. Please try again.";

export interface ChatView {
  render(state: ChatState): void;
}

export interface ChatController {
  submit(message: string): Promise<void>;
  retryInterrupted(): Promise<void>;
  dispose(): void;
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
  let queuedRetry: Promise<void> | undefined;
  let retryClient: CoachClient | undefined;

  const nextId = (prefix: "request" | "message"): string => `${prefix}-${++sequence}`;
  const render = (): void => {
    if (disposed) return;
    try {
      input.view.render(state);
    } catch {}
  };
  const reduce = (action: Parameters<typeof reduceChatState>[1]): void => {
    state = reduceChatState(state, action);
    render();
  };

  const run = (userMessage: string, includeUser: boolean, reconnect: boolean): Promise<void> => {
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
      const current = (): boolean => !disposed && state.activeTurn?.requestKey === requestKey;
      const failProtocol = (): void => {
        protocolFault = true;
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
              if (event.type === "turn-start") {
                if (eventCount !== 0 || startSeen || event.chatId !== DESKTOP_CHAT_ID) {
                  failProtocol();
                  return;
                }
                startSeen = true;
              }
              eventCount += 1;
              if (event.type === "final-text") finalText = event.text;
              reduce({ type: "event", requestKey, event });
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
        reduce({ type: "complete", requestKey });
      } catch (error) {
        if (!current()) return;
        if (protocolFault || error instanceof CoachClientProtocolError) {
          retryClient = client;
          reduce({ type: "interrupt", requestKey, copy: CHAT_PROTOCOL_FAILURE_COPY });
        } else if (error instanceof CoachClientDisconnectedError) {
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
    void task.finally(() => {
      if (activeTask === task) activeTask = undefined;
    });
    return task;
  };

  render();
  return {
    submit(message) {
      if (!/\S/u.test(message) || disposed || state.status === "streaming") {
        return activeTask ?? Promise.resolve();
      }
      return run(message, true, false);
    },
    retryInterrupted() {
      if (disposed || state.status !== "interrupted" || state.activeTurn === null) {
        return activeTask ?? Promise.resolve();
      }
      if (queuedRetry !== undefined) return queuedRetry;
      const userMessage = state.activeTurn.userMessage;
      if (activeTask === undefined) return run(userMessage, false, true);
      const currentTask = activeTask;
      const pending = currentTask
        .then(() => {
          if (disposed || state.status !== "interrupted") return;
          return run(userMessage, false, true);
        })
        .finally(() => {
          if (queuedRetry === pending) queuedRetry = undefined;
        });
      queuedRetry = pending;
      return pending;
    },
    dispose() {
      disposed = true;
      sequence += 1;
    },
  };
}
