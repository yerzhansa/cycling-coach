import type {
  CoachClient,
  CoachClientCallOptions,
  CoachClientTerminalEnvelope,
} from "@enduragent/coach-client";
import {
  CoachClientCallAbortedError,
  CoachClientCallTimeoutError,
  CoachClientDisconnectedError,
  CoachClientProtocolError,
} from "@enduragent/coach-client";
import type {
  AttachmentAdmissionReadModel,
  ChatAttachmentComposerReadModel,
  CoachDecisionAnswer,
  CoachDecisionReadModel,
  ChatQueueSnapshot,
  CoachTurnEventNotificationEnvelope,
  CreateWorkoutPlanningRequestRpcParams,
  PlanningRequestDelivery,
  TranscriptPageEntry,
  TurnEvent,
} from "@enduragent/coach-contract";
import type { DesktopCoachClientProvider } from "../coach-client.js";
import {
  DESKTOP_CHAT_ID,
  EMPTY_CHAT_STATE,
  hasClearableConversation,
  nextDrainGroup,
  reduceChatState,
  type ChatSentAttachment,
  type ChatState,
} from "../turn-state.js";
import {
  createTranscriptHydrator,
  emptyTranscriptHydration,
  mergeHydratedMessages,
  type TranscriptHydrationChange,
  type TranscriptHydrationStatus,
  type TranscriptPage,
} from "./hydration.js";
import { COACH_RESPONSE_CODE_UNIT_LIMIT, COACH_TURN_EVENT_LIMIT } from "./limits.js";

export const CHAT_CONNECTION_INTERRUPTED_COPY =
  "Connection interrupted. Your partial response is preserved.";
export const CHAT_RESPONSE_STOPPED_COPY = "Response stopped. Your partial response is preserved.";
export const CHAT_PROTOCOL_FAILURE_COPY =
  "The coaching response could not be verified. Please try again.";
export const CHAT_FAILURE_COPY = "The coach couldn't respond. Please try again.";
export const CHAT_EMPTY_RESPONSE_COPY = "The coach returned an empty response. Please try again.";
export const CHAT_DECISION_FAILURE_COPY =
  "We couldn’t continue from your choice. Please try again.";
export const CHAT_DECISION_SKIP_FAILURE_COPY = "We couldn’t skip this question. Please try again.";
export const CHAT_DECISION_LOAD_FAILURE_COPY =
  "We couldn’t check for a saved Coach question. Reconnect and try again.";
export const CHAT_QUEUE_LOAD_FAILURE_COPY =
  "We couldn’t check your saved messages. Reconnect and try again.";
export const CHAT_QUEUE_REMOVE_FAILURE_COPY = "We couldn’t remove that saved message. Try again.";
export const CHAT_ATTACHMENT_FAILURE_COPY =
  "We couldn’t update that attachment. Your message draft is preserved.";
export const CHAT_PLANNING_REQUEST_LOAD_FAILURE_COPY =
  "We couldn’t check saved Plan requests. Reconnect and try again.";
export const CHAT_PLANNING_REQUEST_FAILURE_COPY =
  "Plan couldn’t receive this request. The parsed workout is still here.";
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
  readonly decisionLoading?: boolean;
  readonly decisionLoadError?: string | null;
  readonly queueLoadError?: string | null;
  readonly queueMutationError?: string | null;
  readonly attachments?: {
    readonly value: ChatAttachmentComposerReadModel | null;
    readonly admissions: readonly AttachmentAdmissionReadModel[];
    readonly busy: boolean;
    readonly error: string | null;
  };
  readonly planningRequests?: {
    readonly value: readonly PlanningRequestDelivery[];
    readonly loaded: boolean;
    readonly busyId: string | null;
    readonly error: string | null;
    readonly focusId: string | null;
  };
  readonly appendDelta?: ChatAppendDelta;
  readonly hydration?: {
    readonly status: TranscriptHydrationStatus;
    readonly hasEarlier: boolean;
    readonly revision: number;
    readonly change: TranscriptHydrationChange;
    readonly entries?: readonly TranscriptPageEntry[];
  };
  readonly decision?: {
    readonly value: CoachDecisionReadModel | null;
    readonly phase: "idle" | "continuing" | "recovering";
    readonly answerLabel: string | null;
    readonly error: string | null;
  };
}

export interface ChatView {
  render(state: ChatState, controls?: ChatViewControls): void;
}

export interface ChatController {
  start(): Promise<void>;
  resume(): Promise<void>;
  submit(message: string, attachmentIds?: readonly string[]): Promise<boolean>;
  chooseAttachments(): Promise<void>;
  pasteAttachment(): Promise<void>;
  receiveAttachmentAdmissions(results: readonly AttachmentAdmissionReadModel[]): void;
  saveAttachmentDraftText(text: string): void;
  removeAttachment(attachmentId: string): void;
  retryAttachment(attachmentId: string): void;
  selectAttachmentWorkout(attachmentId: string, workoutId: string): void;
  reviewAttachmentInPlan(attachmentId: string): void;
  openPlanningRequest(requestId: string): void;
  retryPlanningRequest(requestId: string): void;
  retryPlanningRequestLoad(): void;
  refreshPlanningRequests(): void;
  focusPlanningRequest(requestId: string): void;
  clearPlanningRequestFocus(): void;
  stop(): void;
  removeQueued(id: string): void;
  runQueuedCommand(id: string): Promise<void>;
  retryQueuedTurn(claimId: string): Promise<void>;
  retryInterrupted(): Promise<void>;
  loadEarlier(): Promise<void>;
  retryHydration(): Promise<void>;
  retryDecision(): Promise<void>;
  openNewConversation(): boolean;
  cancelNewConversation(): void;
  confirmNewConversation(): Promise<void>;
  answerDecision(decisionId: string, answer: CoachDecisionAnswer): Promise<void>;
  skipDecision(decisionId: string): Promise<void>;
  dispose(): void;
}

interface QueuedRetry {
  readonly requestKey: number;
  readonly promise: Promise<void>;
  readonly token: object;
}

interface ChatRun {
  readonly task: Promise<void>;
  completed(): boolean;
}

interface ActiveStopRequest {
  readonly requestKey: number;
  request(): void;
}

export function createChatController(input: {
  readonly clients: DesktopCoachClientProvider;
  readonly view: ChatView;
  readonly refreshTrainingContext: () => Promise<void>;
  readonly refreshSpend: () => Promise<void>;
  readonly readTranscriptPage?: (request: {
    readonly cursor: string | null;
    readonly limit: number;
  }) => Promise<TranscriptPage>;
  readonly canChat?: () => boolean;
  readonly initialQueueSnapshot?: ChatQueueSnapshot;
  readonly nativeAttachments?: {
    readonly choose: () => Promise<readonly AttachmentAdmissionReadModel[]>;
    readonly paste: () => Promise<readonly AttachmentAdmissionReadModel[]>;
  };
  readonly openPlanningRequest?: (chatId: string, requestId: string) => void;
}): ChatController {
  let state =
    input.initialQueueSnapshot === undefined
      ? EMPTY_CHAT_STATE
      : reduceChatState(EMPTY_CHAT_STATE, {
          type: "queue-snapshot",
          snapshot: input.initialQueueSnapshot,
        });
  let hydration = emptyTranscriptHydration();
  let sequence = 0;
  let disposed = false;
  let hydrationRenderSuppressed = false;
  let activeTask: Promise<void> | undefined;
  const outstandingChatTasks = new Set<Promise<void>>();
  let queuedRetry: QueuedRetry | undefined;
  let retryClient: CoachClient | undefined;
  let probeTask: Promise<void> | undefined;
  let resetTask: Promise<void> | undefined;
  let activeStopRequest: ActiveStopRequest | undefined;
  let retryReconnect = true;
  let decision: CoachDecisionReadModel | null = null;
  let decisionPhase: "idle" | "continuing" | "recovering" = "idle";
  let decisionAnswerLabel: string | null = null;
  let decisionError: string | null = null;
  let decisionLoaded = true;
  let decisionLoadError: string | null = null;
  let decisionLoadTask: Promise<void> | undefined;
  let queueLoaded = input.initialQueueSnapshot !== undefined;
  let queueLoadError: string | null = null;
  let queueMutationError: string | null = null;
  let attachmentSurface: ChatAttachmentComposerReadModel | null = null;
  let attachmentAdmissions: readonly AttachmentAdmissionReadModel[] = [];
  let attachmentBusy = false;
  let attachmentError: string | null = null;
  let attachmentTextRevision = 0;
  let attachmentTextSaveTask: Promise<void> = Promise.resolve();
  const attachmentSummaries = new Map<string, ChatSentAttachment>();
  let planningRequests: readonly PlanningRequestDelivery[] = [];
  let planningRequestsLoaded = false;
  let planningRequestBusyId: string | null = null;
  let planningRequestError: string | null = null;
  let planningRequestFocusId: string | null = null;
  let pendingPlanningRequestCreate: CreateWorkoutPlanningRequestRpcParams | null = null;
  let decisionContinuationTask: Promise<void> | undefined;
  let epoch = 0;
  const canChat = input.canChat ?? (() => true);

  const nextId = (prefix: "request" | "message"): string => `${prefix}-${++sequence}`;
  const resetBlocksWork = (): boolean =>
    state.session.resetPhase === "confirming" || state.session.resetPhase === "resetting";
  const decisionBlocksWork = (): boolean =>
    !decisionLoaded ||
    decision?.status === "unanswered" ||
    (decision?.status === "answered" && decision.continuation.status === "pending");
  const canOpenNewConversation = (): boolean =>
    canChat() &&
    queueLoaded &&
    !disposed &&
    (hasClearableConversation(state) ||
      hydration.turns.length > 0 ||
      hydration.entries.length > 0 ||
      attachmentSurface?.draft != null) &&
    state.session.resetPhase === "idle" &&
    state.status !== "streaming" &&
    state.queued.length === 0 &&
    !decisionBlocksWork() &&
    activeTask === undefined &&
    outstandingChatTasks.size === 0 &&
    queuedRetry === undefined &&
    resetTask === undefined;
  const render = (appendDelta?: ChatAppendDelta): void => {
    if (disposed) return;
    try {
      input.view.render(
        hydration.turns.length === 0 && hydration.entries.length === 0
          ? state
          : {
              ...state,
              messages: mergeHydratedMessages(hydration.turns, state.messages, hydration.entries),
            },
        {
          newConversationDisabled: !canOpenNewConversation(),
          workBlocked: resetBlocksWork() || !queueLoaded,
          decisionLoading: !decisionLoaded,
          decisionLoadError,
          queueLoadError,
          queueMutationError,
          attachments: {
            value: attachmentSurface,
            admissions: attachmentAdmissions,
            busy: attachmentBusy,
            error: attachmentError,
          },
          planningRequests: {
            value: planningRequests,
            loaded: planningRequestsLoaded,
            busyId: planningRequestBusyId,
            error: planningRequestError,
            focusId: planningRequestFocusId,
          },
          ...(appendDelta === undefined ? {} : { appendDelta }),
          hydration: {
            status: hydration.status,
            hasEarlier: hydration.nextCursor !== null,
            revision: hydration.revision,
            change: hydration.change,
            entries: hydration.entries,
          },
          decision: {
            value: decision,
            phase: decisionPhase,
            answerLabel: decisionAnswerLabel,
            error: decisionError,
          },
        },
      );
    } catch {}
  };
  const reduce = (
    action: Parameters<typeof reduceChatState>[1],
    appendDelta?: ChatAppendDelta,
  ): void => {
    state = reduceChatState(state, action);
    render(appendDelta);
  };
  const applyQueueSnapshot = (snapshot: ChatQueueSnapshot): void => {
    reduce({ type: "queue-snapshot", snapshot });
  };
  const hydrator = createTranscriptHydrator({
    readPage:
      input.readTranscriptPage ??
      (async () => ({
        schemaVersion: 1,
        status: "page",
        turns: [],
        nextCursor: null,
      })),
    onChange(next) {
      hydration = next;
      if (!hydrationRenderSuppressed) render();
    },
  });
  const updateReset = (
    hydrate: () => void,
    action: Parameters<typeof reduceChatState>[1],
  ): void => {
    hydrationRenderSuppressed = true;
    try {
      hydrate();
      state = reduceChatState(state, action);
    } finally {
      hydrationRenderSuppressed = false;
    }
    render();
  };

  const run = (
    userMessage: string,
    includeUser: boolean,
    reconnect: boolean,
    queueCall?:
      | {
          readonly method: "runQueuedCommand";
          readonly queuedMessageId: string;
          readonly queuedMessageIds: readonly string[];
        }
      | {
          readonly method: "retryQueuedTurn";
          readonly claimId: string;
          readonly queuedMessageIds: readonly string[];
        }
      | { readonly method: "resumeChatQueue"; readonly queuedMessageIds: readonly string[] },
    attachments: readonly ChatSentAttachment[] = [],
  ): ChatRun => {
    epoch += 1;
    const requestKey = Number(nextId("request").slice("request-".length));
    const userMessageId = nextId("message");
    const assistantMessageId = nextId("message");
    let completed = false;
    reduce({
      type: "submit",
      requestKey,
      userMessage,
      userMessageId,
      assistantMessageId,
      includeUser,
      attachments,
    });
    let callStarted = false;
    const task = (async () => {
      let boundRequestId: string | number | undefined;
      let boundTurnId: string | undefined;
      let pendingEnvelope: CoachTurnEventNotificationEnvelope | undefined;
      let eventCount = 0;
      let startSeen = false;
      let finalText: string | undefined;
      let interruptedText: string | undefined;
      let terminal: CoachClientTerminalEnvelope | undefined;
      let terminalHadFinal = false;
      let protocolFault = false;
      let requestedDecision: CoachDecisionReadModel | undefined;
      const callAbortController = new AbortController();
      let client: CoachClient | undefined;
      let stopRequested = false;
      let stopTask: Promise<void> | undefined;
      const current = (): boolean => !disposed && state.activeTurn?.requestKey === requestKey;
      const failProtocol = (): void => {
        if (protocolFault) return;
        protocolFault = true;
        callAbortController.abort();
      };
      const requestStop = (): void => {
        stopRequested = true;
        if (client === undefined || boundTurnId === undefined || stopTask !== undefined) return;
        stopTask = client
          .call("stopChat", { chatId: DESKTOP_CHAT_ID, turnId: boundTurnId })
          .then(() => undefined)
          .catch(() => undefined);
      };
      activeStopRequest = { requestKey, request: requestStop };

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
        const callOptions = {
          signal: callAbortController.signal,
          onNotificationEnvelope(envelope) {
            if (!current() || protocolFault) return;
            if (
              envelope.method !== "coach.turnEvent" ||
              envelope.params.requestMethod !== (queueCall?.method ?? "chat") ||
              envelope.params.turnId.length === 0
            ) {
              failProtocol();
              return;
            }
            if (boundRequestId === undefined) {
              boundRequestId = envelope.params.requestId;
              boundTurnId = envelope.params.turnId;
              reduce({ type: "bind-turn", requestKey, turnId: boundTurnId });
              if (stopRequested) requestStop();
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
            if (requestedDecision !== undefined) {
              failProtocol();
              return;
            }
            if (event.type === "turn-start") {
              if (eventCount !== 1 || startSeen || event.chatId !== DESKTOP_CHAT_ID) {
                failProtocol();
                return;
              }
              startSeen = true;
              if (queueCall !== undefined) {
                reduce({ type: "queue-claimed", ids: queueCall.queuedMessageIds });
              }
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
              (event.type === "final-text" || event.type === "interrupted") &&
              event.text.length > COACH_RESPONSE_CODE_UNIT_LIMIT
            ) {
              failProtocol();
              return;
            }
            if (event.type === "final-text") finalText = event.text;
            if (event.type === "interrupted") interruptedText = event.text;
            if (event.type === "decision-requested") {
              if (
                !startSeen ||
                event.chatId !== DESKTOP_CHAT_ID ||
                event.decision.status !== "unanswered"
              ) {
                failProtocol();
                return;
              }
              requestedDecision = event.decision;
              reduce({
                type: "bind-decision",
                requestKey,
                decisionId: event.decision.decisionId,
              });
              decision = event.decision;
              decisionPhase = "idle";
              decisionAnswerLabel = null;
              decisionError = null;
              render();
              return;
            }
            reduce({ type: "event", requestKey, event }, appendDelta);
          },
          onTerminalEnvelope(envelope) {
            if (!current()) return;
            terminal = envelope;
            terminalHadFinal = finalText !== undefined;
          },
        } satisfies CoachClientCallOptions<"chat">;
        const queuedResult =
          queueCall?.method === "resumeChatQueue"
            ? await client.call("resumeChatQueue", { chatId: DESKTOP_CHAT_ID }, callOptions)
            : queueCall?.method === "runQueuedCommand"
              ? await client.call(
                  "runQueuedCommand",
                  { chatId: DESKTOP_CHAT_ID, queuedMessageId: queueCall.queuedMessageId },
                  callOptions,
                )
              : queueCall?.method === "retryQueuedTurn"
                ? await client.call(
                    "retryQueuedTurn",
                    { chatId: DESKTOP_CHAT_ID, claimId: queueCall.claimId },
                    callOptions,
                  )
                : undefined;
        const result =
          queuedResult === undefined
            ? await client.call(
                "chat",
                { chatId: DESKTOP_CHAT_ID, message: userMessage },
                callOptions,
              )
            : (queuedResult.response ?? { text: "" });
        if (!current()) return;
        if (queuedResult !== undefined) applyQueueSnapshot(queuedResult.snapshot);
        if (
          queuedResult !== undefined &&
          queuedResult.response === undefined &&
          boundTurnId === undefined
        ) {
          reduce({ type: "discard-submission", requestKey });
          return;
        }
        if (interruptedText !== undefined) {
          if (
            protocolFault ||
            terminal === undefined ||
            !("result" in terminal) ||
            finalText !== undefined ||
            result.text !== interruptedText
          ) {
            retryClient = client;
            retryReconnect = true;
            reduce({ type: "interrupt", requestKey, copy: CHAT_PROTOCOL_FAILURE_COPY });
            return;
          }
          retryClient = undefined;
          retryReconnect = false;
          completed = true;
          return;
        }
        if (requestedDecision !== undefined) {
          if (
            protocolFault ||
            terminal === undefined ||
            !("result" in terminal) ||
            finalText !== undefined
          ) {
            retryClient = client;
            retryReconnect = true;
            decision = null;
            reduce({ type: "interrupt", requestKey, copy: CHAT_PROTOCOL_FAILURE_COPY });
            return;
          }
          reduce({ type: "discard", requestKey });
          return;
        }
        if (
          protocolFault ||
          terminal === undefined ||
          !("result" in terminal) ||
          !terminalHadFinal ||
          finalText === undefined ||
          !("text" in result) ||
          result.text !== finalText
        ) {
          retryClient = client;
          retryReconnect = true;
          reduce({ type: "interrupt", requestKey, copy: CHAT_PROTOCOL_FAILURE_COPY });
          return;
        }
        if (!/\S/u.test(finalText)) {
          retryClient = client;
          retryReconnect = true;
          reduce({ type: "interrupt", requestKey, copy: CHAT_EMPTY_RESPONSE_COPY });
          return;
        }
        reduce({ type: "complete", requestKey });
        completed = state.status === "idle" && state.activeTurn?.requestKey === requestKey;
      } catch (error) {
        if (!current()) return;
        if (queueCall !== undefined && client !== undefined) {
          try {
            applyQueueSnapshot(await client.call("getChatQueue", { chatId: DESKTOP_CHAT_ID }));
          } catch {}
        }
        if (protocolFault || error instanceof CoachClientProtocolError) {
          retryClient = client;
          retryReconnect = true;
          reduce({ type: "interrupt", requestKey, copy: CHAT_PROTOCOL_FAILURE_COPY });
        } else if (
          error instanceof CoachClientDisconnectedError ||
          error instanceof CoachClientCallTimeoutError ||
          error instanceof CoachClientCallAbortedError
        ) {
          retryClient = client;
          retryReconnect = true;
          reduce({ type: "interrupt", requestKey, copy: CHAT_CONNECTION_INTERRUPTED_COPY });
        } else {
          reduce({ type: "fail", requestKey, copy: CHAT_FAILURE_COPY });
        }
      } finally {
        if (activeStopRequest?.requestKey === requestKey) activeStopRequest = undefined;
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
    return { task, completed: () => completed };
  };

  const dispatch = (
    userMessage: string,
    includeUser: boolean,
    reconnect: boolean,
  ): Promise<void> => {
    const chatRun = run(userMessage, includeUser, reconnect);
    return chatRun.task.then(() => (chatRun.completed() ? drain() : undefined));
  };

  const dispatchQueue = (
    userMessage: string,
    queueCall:
      | {
          readonly method: "runQueuedCommand";
          readonly queuedMessageId: string;
          readonly queuedMessageIds: readonly string[];
        }
      | {
          readonly method: "retryQueuedTurn";
          readonly claimId: string;
          readonly queuedMessageIds: readonly string[];
        }
      | { readonly method: "resumeChatQueue"; readonly queuedMessageIds: readonly string[] },
    includeUser = true,
  ): Promise<void> => {
    const attachments = queueCall.queuedMessageIds
      .flatMap((id) => state.queued.find((message) => message.id === id)?.attachmentIds ?? [])
      .map((id) => attachmentSummaries.get(id))
      .filter((attachment): attachment is ChatSentAttachment => attachment !== undefined);
    const chatRun = run(userMessage, includeUser, false, queueCall, attachments);
    return chatRun.task.then(() => (chatRun.completed() ? drain() : undefined));
  };

  const answerLabel = (
    currentDecision: CoachDecisionReadModel,
    answer: CoachDecisionAnswer,
  ): string => {
    if (answer.kind === "custom") return answer.text;
    return (
      currentDecision.options.find((option) => option.id === answer.optionId)?.label ??
      "Saved choice"
    );
  };

  const refreshDecision = async (client?: CoachClient): Promise<CoachDecisionReadModel | null> => {
    const activeClient = client ?? (await input.clients.getClient());
    const result = await activeClient.call("getCoachDecision", { chatId: DESKTOP_CHAT_ID });
    if (disposed) return null;
    decision = result.decision;
    decisionPhase =
      decision?.status === "answered" && decision.continuation.status === "pending"
        ? "recovering"
        : "idle";
    if (decision?.status !== "answered") decisionAnswerLabel = null;
    decisionError = null;
    decisionLoaded = true;
    decisionLoadError = null;
    render();
    return decision;
  };

  const refreshQueue = async (client?: CoachClient): Promise<void> => {
    const activeClient = client ?? (await input.clients.getClient());
    const snapshot = await activeClient.call("getChatQueue", { chatId: DESKTOP_CHAT_ID });
    if (disposed) return;
    applyQueueSnapshot(snapshot);
    queueLoaded = true;
    queueLoadError = null;
    render();
  };

  const refreshAttachments = async (client?: CoachClient): Promise<void> => {
    const activeClient = client ?? (await input.clients.getClient());
    const surface = await activeClient.call("getChatAttachmentComposer", {
      chatId: DESKTOP_CHAT_ID,
    });
    if (disposed) return;
    attachmentSurface = surface;
    attachmentError = null;
    render();
  };

  const replacePlanningRequest = (delivery: PlanningRequestDelivery): void => {
    planningRequests = [
      ...planningRequests.filter((item) => item.requestId !== delivery.requestId),
      delivery,
    ].sort(
      (left, right) =>
        left.createdAtMs - right.createdAtMs || left.requestId.localeCompare(right.requestId),
    );
  };

  const loadPlanningRequests = async (client?: CoachClient): Promise<void> => {
    const activeClient = client ?? (await input.clients.getClient());
    const result = await activeClient.call("listPlanningRequests", { chatId: DESKTOP_CHAT_ID });
    if (disposed) return;
    planningRequests = result.deliveries;
    planningRequestsLoaded = true;
    planningRequestError = null;
    render();
  };

  const recoverPlanningRequests = async (): Promise<void> => {
    const client = await input.clients.getClient();
    let recoveryFailed = false;
    try {
      await client.call("resumePlanningRequests", {});
    } catch {
      recoveryFailed = true;
    }
    await loadPlanningRequests(client);
    if (recoveryFailed) throw new Error("Planning request recovery failed.");
  };

  const routeToPlanningRequest = (requestId: string): void => {
    const delivery = planningRequests.find((item) => item.requestId === requestId);
    if (delivery?.state !== "delivered") return;
    input.openPlanningRequest?.(DESKTOP_CHAT_ID, requestId);
  };

  const retrySavedPlanningRequest = (requestId: string): void => {
    const delivery = planningRequests.find((item) => item.requestId === requestId);
    if (
      disposed ||
      planningRequestBusyId !== null ||
      delivery?.state !== "failed" ||
      !delivery.retryable
    ) {
      return;
    }
    planningRequestBusyId = requestId;
    planningRequestError = null;
    render();
    void input.clients
      .getClient()
      .then((client) => client.call("retryPlanningRequest", { requestId }))
      .then((result) => {
        if (disposed) return;
        planningRequestBusyId = null;
        if (result.status === "missing") {
          planningRequestError = CHAT_PLANNING_REQUEST_FAILURE_COPY;
          render();
          return;
        }
        replacePlanningRequest(result.delivery);
        planningRequestError = null;
        render();
        routeToPlanningRequest(requestId);
      })
      .catch(() => {
        if (disposed) return;
        planningRequestBusyId = null;
        planningRequestError = CHAT_PLANNING_REQUEST_FAILURE_COPY;
        render();
      });
  };

  const deliverWorkoutPlanningRequest = (
    request: CreateWorkoutPlanningRequestRpcParams,
  ): void => {
    if (disposed || planningRequestBusyId !== null) return;
    pendingPlanningRequestCreate = request;
    planningRequestBusyId = request.requestId;
    planningRequestError = null;
    render();
    void input.clients
      .getClient()
      .then((client) => client.call("createWorkoutPlanningRequest", request))
      .then((result) => {
        if (disposed) return;
        planningRequestBusyId = null;
        if (result.status === "rejected") {
          pendingPlanningRequestCreate = null;
          planningRequestError = CHAT_PLANNING_REQUEST_FAILURE_COPY;
          render();
          return;
        }
        pendingPlanningRequestCreate = null;
        replacePlanningRequest(result.delivery);
        planningRequestError = null;
        render();
        routeToPlanningRequest(request.requestId);
      })
      .catch(() => {
        if (disposed) return;
        planningRequestBusyId = null;
        planningRequestError = CHAT_PLANNING_REQUEST_FAILURE_COPY;
        render();
      });
  };

  const receiveAdmissions = (results: readonly AttachmentAdmissionReadModel[]): void => {
    if (disposed) return;
    attachmentAdmissions = results.filter((result) => result.status !== "accepted");
    attachmentError = null;
    render();
    void refreshAttachments().catch(() => {
      if (disposed) return;
      attachmentError = CHAT_ATTACHMENT_FAILURE_COPY;
      render();
    });
  };

  const runNativeAttachmentAction = async (
    operation: (() => Promise<readonly AttachmentAdmissionReadModel[]>) | undefined,
  ): Promise<void> => {
    if (operation === undefined || disposed || attachmentBusy || resetBlocksWork()) return;
    attachmentBusy = true;
    attachmentError = null;
    render();
    try {
      receiveAdmissions(await operation());
    } catch {
      if (!disposed) attachmentError = CHAT_ATTACHMENT_FAILURE_COPY;
    } finally {
      if (!disposed) {
        attachmentBusy = false;
        render();
      }
    }
  };

  const mutateAttachment = async (
    operation: (client: CoachClient) => Promise<ChatAttachmentComposerReadModel>,
  ): Promise<void> => {
    if (disposed || resetBlocksWork()) return;
    attachmentBusy = true;
    attachmentError = null;
    render();
    try {
      const client = await input.clients.getClient();
      const surface = await operation(client);
      if (!disposed) {
        attachmentSurface = surface;
        attachmentError = null;
      }
    } catch {
      if (!disposed) attachmentError = CHAT_ATTACHMENT_FAILURE_COPY;
    } finally {
      if (!disposed) {
        attachmentBusy = false;
        render();
      }
    }
  };

  const continueDecision = (
    method: "answerCoachDecision" | "resumeCoachDecision",
    currentDecision: CoachDecisionReadModel,
    answer: CoachDecisionAnswer | undefined,
  ): Promise<void> => {
    if (decisionContinuationTask !== undefined) return decisionContinuationTask;
    const requestKey = Number(nextId("request").slice("request-".length));
    const userMessageId = nextId("message");
    const assistantMessageId = nextId("message");
    const restoreCompletedContinuation = (
      completed: Extract<CoachDecisionReadModel, { status: "answered" }> & {
        readonly continuation: Extract<
          Extract<CoachDecisionReadModel, { status: "answered" }>["continuation"],
          { status: "completed" }
        >;
      },
    ): void => {
      if (
        state.messages.some(
          (message) => message.role === "coach" && message.turnId === completed.continuation.turnId,
        )
      ) {
        return;
      }
      reduce({
        type: "submit",
        requestKey,
        userMessage: "",
        userMessageId,
        assistantMessageId,
        includeUser: false,
      });
      reduce({
        type: "bind-turn",
        requestKey,
        turnId: completed.continuation.turnId,
      });
      reduce({
        type: "event",
        requestKey,
        event: {
          type: "final-text",
          turnId: completed.continuation.turnId,
          text: completed.continuation.coachText,
        },
      });
      reduce({ type: "complete", requestKey });
    };
    decisionPhase = method === "resumeCoachDecision" ? "recovering" : "continuing";
    decisionAnswerLabel =
      answer === undefined
        ? currentDecision.status === "answered"
          ? answerLabel(currentDecision, currentDecision.answer)
          : "Saved choice"
        : answerLabel(currentDecision, answer);
    decisionError = null;
    reduce({
      type: "submit",
      requestKey,
      userMessage: "",
      userMessageId,
      assistantMessageId,
      includeUser: false,
    });
    const task = (async () => {
      let client: CoachClient | undefined;
      let boundRequestId: string | number | undefined;
      let boundTurnId: string | undefined;
      let pendingEnvelope: CoachTurnEventNotificationEnvelope | undefined;
      let terminal: CoachClientTerminalEnvelope | undefined;
      let finalText: string | undefined;
      let interruptedText: string | undefined;
      let eventCount = 0;
      let startSeen = false;
      let protocolFault = false;
      const callAbortController = new AbortController();
      let stopRequested = false;
      let stopTask: Promise<void> | undefined;
      const current = (): boolean =>
        !disposed &&
        state.activeTurn?.requestKey === requestKey &&
        decision?.decisionId === currentDecision.decisionId;
      const failProtocol = (): void => {
        if (protocolFault) return;
        protocolFault = true;
        callAbortController.abort();
      };
      const requestStop = (): void => {
        stopRequested = true;
        if (client === undefined || boundTurnId === undefined || stopTask !== undefined) return;
        stopTask = client
          .call("stopChat", { chatId: DESKTOP_CHAT_ID, turnId: boundTurnId })
          .then(() => undefined)
          .catch(() => undefined);
      };
      activeStopRequest = { requestKey, request: requestStop };
      const callOptions = {
        signal: callAbortController.signal,
        onNotificationEnvelope(envelope) {
          if (!current() || protocolFault) return;
          if (
            envelope.method !== "coach.turnEvent" ||
            envelope.params.requestMethod !== method ||
            envelope.params.turnId.length === 0
          ) {
            failProtocol();
            return;
          }
          if (boundRequestId === undefined) {
            boundRequestId = envelope.params.requestId;
            boundTurnId = envelope.params.turnId;
            reduce({ type: "bind-turn", requestKey, turnId: boundTurnId });
            if (stopRequested) requestStop();
          } else if (
            envelope.params.requestId !== boundRequestId ||
            envelope.params.turnId !== boundTurnId
          ) {
            failProtocol();
            return;
          }
          pendingEnvelope = envelope;
        },
        onEvent(event) {
          if (!current() || protocolFault) return;
          const envelope = pendingEnvelope;
          pendingEnvelope = undefined;
          if (
            envelope === undefined ||
            boundTurnId === undefined ||
            event.turnId !== boundTurnId ||
            envelope.params.event.turnId !== boundTurnId ||
            event.type === "decision-requested"
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
          } else if (!startSeen) {
            failProtocol();
            return;
          }
          if (event.type === "text_delta") {
            const previousTextLength = state.activeTurn?.draft.length ?? 0;
            if (event.delta.length > COACH_RESPONSE_CODE_UNIT_LIMIT - previousTextLength) {
              failProtocol();
              return;
            }
          }
          if (
            (event.type === "final-text" || event.type === "interrupted") &&
            event.text.length > COACH_RESPONSE_CODE_UNIT_LIMIT
          ) {
            failProtocol();
            return;
          }
          if (event.type === "final-text") finalText = event.text;
          if (event.type === "interrupted") interruptedText = event.text;
          reduce({ type: "event", requestKey, event });
        },
        onTerminalEnvelope(envelope) {
          if (current()) terminal = envelope;
        },
      } satisfies CoachClientCallOptions<"answerCoachDecision">;
      try {
        client = await input.clients.getClient();
        if (!current()) return;
        const result =
          method === "answerCoachDecision"
            ? await client.call(
                "answerCoachDecision",
                {
                  chatId: DESKTOP_CHAT_ID,
                  decisionId: currentDecision.decisionId,
                  answer: answer as CoachDecisionAnswer,
                },
                callOptions,
              )
            : await client.call(
                "resumeCoachDecision",
                { chatId: DESKTOP_CHAT_ID, decisionId: currentDecision.decisionId },
                callOptions,
              );
        if (!current()) return;
        if (protocolFault || terminal === undefined || !("result" in terminal)) {
          throw new CoachClientProtocolError();
        }
        decision = result.decision;
        if (interruptedText !== undefined) {
          if (
            finalText !== undefined ||
            result.decision.status !== "answered" ||
            result.decision.continuation.status !== "pending"
          ) {
            throw new CoachClientProtocolError();
          }
          decisionPhase = "recovering";
          decisionError = CHAT_RESPONSE_STOPPED_COPY;
          return;
        }
        if (
          result.decision.status === "answered" &&
          result.decision.continuation.status === "completed"
        ) {
          if (
            finalText === undefined ||
            result.decision.continuation.coachText !== finalText ||
            result.decision.continuation.turnId !== boundTurnId
          ) {
            throw new CoachClientProtocolError();
          }
          reduce({ type: "complete", requestKey });
          decisionPhase = "idle";
          decisionError = null;
          return;
        }
        reduce({ type: "discard", requestKey });
        decisionPhase = "recovering";
        decisionError = CHAT_DECISION_FAILURE_COPY;
      } catch {
        if (!current()) return;
        reduce({ type: "discard", requestKey });
        decisionPhase = "recovering";
        decisionError = CHAT_DECISION_FAILURE_COPY;
        try {
          const refreshed = await refreshDecision(client);
          if (refreshed?.status === "answered" && refreshed.continuation.status === "pending") {
            decisionError = CHAT_DECISION_FAILURE_COPY;
            render();
          } else if (
            refreshed?.status === "answered" &&
            refreshed.continuation.status === "completed"
          ) {
            restoreCompletedContinuation({
              ...refreshed,
              continuation: refreshed.continuation,
            });
            decisionPhase = "idle";
            decisionError = null;
            render();
          } else if (refreshed?.status === "unanswered") {
            decisionPhase = "idle";
            decisionError = CHAT_DECISION_FAILURE_COPY;
            render();
          }
        } catch {
          render();
        }
      } finally {
        if (activeStopRequest?.requestKey === requestKey) activeStopRequest = undefined;
        try {
          void input.refreshSpend().catch(() => {});
        } catch {}
        try {
          await input.refreshTrainingContext();
        } catch {}
      }
    })();
    decisionContinuationTask = task;
    activeTask = task;
    render();
    void task.finally(() => {
      if (decisionContinuationTask === task) decisionContinuationTask = undefined;
      if (activeTask === task) activeTask = undefined;
      render();
      if (!decisionBlocksWork()) void drain();
    });
    return task;
  };

  const drain = (): Promise<void> => {
    if (
      !canChat() ||
      !queueLoaded ||
      disposed ||
      resetBlocksWork() ||
      decisionBlocksWork() ||
      state.status === "streaming"
    ) {
      return Promise.resolve();
    }
    const group = nextDrainGroup(state);
    if (group === null) return Promise.resolve();
    if (
      state.retryRequired != null ||
      (state.queued[0]?.command === true && state.queued[0]?.restored === true)
    )
      return Promise.resolve();
    return dispatchQueue(group.text, {
      method: "resumeChatQueue",
      queuedMessageIds: state.queued.slice(0, group.size).map((item) => item.id),
    });
  };

  const start = (): Promise<void> => {
    if (!canChat() || disposed) return Promise.resolve();
    if (probeTask !== undefined) return probeTask;
    const transcriptLoadTask = hydrator.start();
    decisionLoaded = false;
    decisionLoadError = null;
    render();
    const loadTask = (async () => {
      try {
        const loaded = await refreshDecision();
        decisionLoaded = true;
        render();
        if (
          loaded?.status === "answered" &&
          loaded.continuation.status === "pending" &&
          decisionContinuationTask === undefined
        ) {
          await continueDecision("resumeCoachDecision", loaded, undefined);
        }
      } catch {
        decisionLoaded = false;
        decisionLoadError = CHAT_DECISION_LOAD_FAILURE_COPY;
        decisionPhase = "idle";
        render();
      }
    })();
    decisionLoadTask = loadTask;
    void loadTask.finally(() => {
      if (decisionLoadTask === loadTask) decisionLoadTask = undefined;
      render();
      if (!decisionBlocksWork()) void drain();
    });
    const probeEpoch = epoch;
    const sessionProbeTask = (async () => {
      try {
        const client = await input.clients.getClient();
        const result = await client.call("hasSession", { chatId: DESKTOP_CHAT_ID });
        if (disposed || epoch !== probeEpoch) return;
        reduce({ type: "session-probe", hasSession: result.hasSession });
      } catch {}
    })();
    const queueLoadTask = (async () => {
      try {
        await refreshQueue();
      } catch {
        queueLoaded = false;
        queueLoadError = CHAT_QUEUE_LOAD_FAILURE_COPY;
        render();
      }
    })();
    const attachmentLoadTask = refreshAttachments().catch(() => {
      if (!disposed) {
        attachmentError = CHAT_ATTACHMENT_FAILURE_COPY;
        render();
      }
    });
    const planningRequestLoadTask = recoverPlanningRequests().catch(() => {
      if (!disposed) {
        planningRequestsLoaded = false;
        planningRequestError = CHAT_PLANNING_REQUEST_LOAD_FAILURE_COPY;
        render();
      }
    });
    const task = Promise.all([
      transcriptLoadTask,
      sessionProbeTask,
      loadTask,
      queueLoadTask,
      attachmentLoadTask,
      planningRequestLoadTask,
    ]).then(async () => {
      if (!decisionBlocksWork()) await drain();
    });
    probeTask = task;
    return task;
  };

  render();
  return {
    start() {
      return start();
    },
    resume() {
      return start().then(() => drain());
    },
    submit(message, attachmentIds = []) {
      if (
        !canChat() ||
        !queueLoaded ||
        (!/\S/u.test(message) && attachmentIds.length === 0) ||
        (/^\s*\//u.test(message) && attachmentIds.length > 0) ||
        disposed ||
        resetBlocksWork() ||
        decisionBlocksWork()
      ) {
        return Promise.resolve(false);
      }
      const submissionId = globalThis.crypto.randomUUID();
      const submittedAttachments = (attachmentSurface?.draft?.attachments ?? [])
        .filter((attachment) => attachmentIds.includes(attachment.attachmentId))
        .map(({ attachmentId, displayName, kind, extension }) => ({
          attachmentId,
          displayName,
          kind,
          extension,
        }));
      return input.clients.getClient().then(async (client) => {
        await attachmentTextSaveTask;
        const acknowledged = await client.call("enqueueChatMessage", {
          chatId: DESKTOP_CHAT_ID,
          submissionId,
          text: message,
          ...(attachmentIds.length === 0 ? {} : { attachmentIds: [...attachmentIds] }),
        });
        if (disposed) return false;
        for (const attachment of submittedAttachments) {
          attachmentSummaries.set(attachment.attachmentId, attachment);
        }
        attachmentAdmissions = [];
        attachmentSurface =
          attachmentSurface === null ? null : { ...attachmentSurface, draft: null };
        applyQueueSnapshot(acknowledged);
        void drain();
        void refreshAttachments(client).catch(() => {});
        return true;
      });
    },
    chooseAttachments() {
      return runNativeAttachmentAction(input.nativeAttachments?.choose);
    },
    pasteAttachment() {
      return runNativeAttachmentAction(input.nativeAttachments?.paste);
    },
    receiveAttachmentAdmissions(results) {
      receiveAdmissions(results);
    },
    saveAttachmentDraftText(text) {
      if (disposed || resetBlocksWork()) return;
      const revision = ++attachmentTextRevision;
      const task = attachmentTextSaveTask.then(async () => {
        try {
          const client = await input.clients.getClient();
          const surface = await client.call("saveChatAttachmentDraftText", {
            chatId: DESKTOP_CHAT_ID,
            text,
          });
          if (disposed || revision !== attachmentTextRevision) return;
          attachmentSurface = surface;
          attachmentError = null;
          render();
        } catch {
          if (disposed || revision !== attachmentTextRevision) return;
          attachmentError = CHAT_ATTACHMENT_FAILURE_COPY;
          render();
        }
      });
      attachmentTextSaveTask = task;
    },
    removeAttachment(attachmentId) {
      void mutateAttachment((client) =>
        client.call("removeChatAttachment", { chatId: DESKTOP_CHAT_ID, attachmentId }),
      );
    },
    retryAttachment(attachmentId) {
      void mutateAttachment((client) =>
        client.call("retryChatAttachment", { chatId: DESKTOP_CHAT_ID, attachmentId }),
      );
    },
    selectAttachmentWorkout(attachmentId, workoutId) {
      void mutateAttachment((client) =>
        client.call("selectChatAttachmentWorkout", {
          chatId: DESKTOP_CHAT_ID,
          attachmentId,
          workoutId,
        }),
      );
    },
    reviewAttachmentInPlan(attachmentId) {
      if (
        disposed ||
        resetBlocksWork() ||
        !planningRequestsLoaded ||
        planningRequestBusyId !== null
      ) {
        return;
      }
      const attachment = attachmentSurface?.draft?.attachments.find(
        (item) => item.attachmentId === attachmentId,
      );
      if (
        attachment?.status !== "ready" ||
        attachment.preview.kind !== "workout" ||
        attachment.preview.selectedWorkoutId === null
      ) {
        return;
      }
      const existing = planningRequests.find(
        (delivery) =>
          delivery.source?.attachmentId === attachmentId &&
          (delivery.state !== "delivered" || delivery.planningRequest?.lifecycle === "open"),
      );
      if (existing !== undefined) {
        if (existing.state === "failed" && existing.retryable) {
          retrySavedPlanningRequest(existing.requestId);
        } else {
          routeToPlanningRequest(existing.requestId);
        }
        return;
      }
      const preview = attachment.preview;
      const selected = preview.workouts.find(
        (workout) => workout.workoutId === preview.selectedWorkoutId,
      );
      if (selected === undefined) return;
      const requestId = globalThis.crypto.randomUUID();
      deliverWorkoutPlanningRequest({
        requestId,
        intent: `Review ${selected.title} in Plan.`,
        source: {
          chatId: DESKTOP_CHAT_ID,
          messageId: globalThis.crypto.randomUUID(),
          attachmentId,
        },
      });
    },
    openPlanningRequest(requestId) {
      if (disposed) return;
      routeToPlanningRequest(requestId);
    },
    retryPlanningRequest(requestId) {
      retrySavedPlanningRequest(requestId);
    },
    retryPlanningRequestLoad() {
      if (disposed || planningRequestBusyId !== null) return;
      if (pendingPlanningRequestCreate !== null) {
        deliverWorkoutPlanningRequest(pendingPlanningRequestCreate);
        return;
      }
      planningRequestError = null;
      render();
      void recoverPlanningRequests().catch(() => {
        if (disposed) return;
        planningRequestsLoaded = false;
        planningRequestError = CHAT_PLANNING_REQUEST_LOAD_FAILURE_COPY;
        render();
      });
    },
    refreshPlanningRequests() {
      if (disposed || planningRequestBusyId !== null) return;
      void loadPlanningRequests().catch(() => {
        if (disposed) return;
        planningRequestsLoaded = false;
        planningRequestError = CHAT_PLANNING_REQUEST_LOAD_FAILURE_COPY;
        render();
      });
    },
    focusPlanningRequest(requestId) {
      if (disposed) return;
      planningRequestFocusId = requestId;
      render();
    },
    clearPlanningRequestFocus() {
      if (disposed || planningRequestFocusId === null) return;
      planningRequestFocusId = null;
      render();
    },
    stop() {
      if (disposed || state.status !== "streaming" || state.activeTurn === null) return;
      activeStopRequest?.request();
    },
    removeQueued(id) {
      if (disposed || resetBlocksWork()) return;
      queueMutationError = null;
      render();
      void input.clients.getClient().then(
        async (client) => {
          try {
            const acknowledged = await client.call("removeQueuedChatMessage", {
              chatId: DESKTOP_CHAT_ID,
              queuedMessageId: id,
            });
            if (!disposed) {
              queueMutationError = null;
              applyQueueSnapshot(acknowledged);
            }
          } catch {
            if (!disposed) {
              queueMutationError = CHAT_QUEUE_REMOVE_FAILURE_COPY;
              render();
            }
          }
        },
        () => {
          if (!disposed) {
            queueMutationError = CHAT_QUEUE_REMOVE_FAILURE_COPY;
            render();
          }
        },
      );
    },
    runQueuedCommand(id) {
      if (
        disposed ||
        !queueLoaded ||
        resetBlocksWork() ||
        decisionBlocksWork() ||
        state.status !== "idle"
      ) {
        return activeTask ?? Promise.resolve();
      }
      const head = state.queued[0];
      if (head?.id !== id || !head.command) return Promise.resolve();
      return dispatchQueue(head.text, {
        method: "runQueuedCommand",
        queuedMessageId: id,
        queuedMessageIds: [id],
      });
    },
    retryQueuedTurn(claimId) {
      if (
        disposed ||
        !queueLoaded ||
        resetBlocksWork() ||
        decisionBlocksWork() ||
        (state.status !== "idle" && state.status !== "interrupted")
      ) {
        return activeTask ?? Promise.resolve();
      }
      if (state.retryRequired?.claimId !== claimId) return Promise.resolve();
      const ids = new Set(state.retryRequired.queuedMessageIds);
      const text = state.queued
        .filter((item) => ids.has(item.id))
        .map((item) => item.text)
        .join("\n\n");
      return dispatchQueue(
        text,
        { method: "retryQueuedTurn", claimId, queuedMessageIds: [...ids] },
        false,
      );
    },
    retryInterrupted() {
      if (
        !canChat() ||
        !queueLoaded ||
        disposed ||
        state.status !== "interrupted" ||
        state.retryRequired != null ||
        state.activeTurn === null ||
        resetBlocksWork()
      ) {
        return activeTask ?? Promise.resolve();
      }
      const { requestKey, userMessage } = state.activeTurn;
      if (queuedRetry?.requestKey === requestKey) return queuedRetry.promise;
      if (activeTask === undefined) return dispatch(userMessage, false, retryReconnect);
      const currentTask = activeTask;
      const token = {};
      const pending = currentTask
        .then(() => {
          if (
            !canChat() ||
            disposed ||
            state.status !== "interrupted" ||
            state.activeTurn?.requestKey !== requestKey
          ) {
            return;
          }
          return dispatch(userMessage, false, retryReconnect);
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
    loadEarlier() {
      return hydrator.loadEarlier();
    },
    retryHydration() {
      return hydrator.retry();
    },
    async retryDecision() {
      if (disposed || decisionLoadTask !== undefined) return decisionLoadTask;
      decisionLoaded = false;
      decisionLoadError = null;
      queueLoadError = null;
      render();
      const task = (async () => {
        try {
          const client = await input.clients.reconnect();
          const [loaded] = await Promise.all([refreshDecision(client), refreshQueue(client)]);
          if (
            loaded?.status === "answered" &&
            loaded.continuation.status === "pending" &&
            decisionContinuationTask === undefined
          ) {
            await continueDecision("resumeCoachDecision", loaded, undefined);
          }
        } catch {
          decisionLoaded = false;
          if (!queueLoaded) queueLoadError = CHAT_QUEUE_LOAD_FAILURE_COPY;
          else decisionLoadError = CHAT_DECISION_LOAD_FAILURE_COPY;
          decisionPhase = "idle";
          render();
        }
      })();
      decisionLoadTask = task;
      await task.finally(() => {
        if (decisionLoadTask === task) decisionLoadTask = undefined;
        render();
        if (!decisionBlocksWork()) void drain();
      });
    },
    openNewConversation() {
      if (!canChat()) return false;
      if (!canOpenNewConversation()) return false;
      epoch += 1;
      state = reduceChatState(state, {
        type: "open-new-conversation",
        hasHydratedHistory: hydration.turns.length > 0 || hydration.entries.length > 0,
      });
      render();
      return true;
    },
    cancelNewConversation() {
      if (!canChat() || disposed || state.session.resetPhase !== "confirming") return;
      reduce({ type: "cancel-new-conversation" });
    },
    confirmNewConversation() {
      if (resetTask !== undefined) return resetTask;
      if (!canChat() || disposed || state.session.resetPhase !== "confirming") {
        return Promise.resolve();
      }
      updateReset(() => hydrator.beginReset(), { type: "begin-reset" });
      const resetEpoch = ++epoch;
      const task = (async () => {
        try {
          const client = await input.clients.getClient();
          const result = await client.call("resetSession", { chatId: DESKTOP_CHAT_ID });
          if (disposed || epoch !== resetEpoch) return;
          try {
            attachmentSurface = await client.call("clearChatAttachmentDraft", {
              chatId: DESKTOP_CHAT_ID,
            });
            attachmentAdmissions = [];
            attachmentError = null;
          } catch {
            attachmentError = CHAT_ATTACHMENT_FAILURE_COPY;
          }
          sequence += 1;
          retryClient = undefined;
          queuedRetry = undefined;
          decision = null;
          decisionLoaded = true;
          decisionLoadError = null;
          decisionPhase = "idle";
          decisionAnswerLabel = null;
          decisionError = null;
          attachmentSummaries.clear();
          updateReset(() => hydrator.resetSucceeded(), {
            type: "reset-succeeded",
            announcement: result.memoryFlushed
              ? NEW_CONVERSATION_SUCCESS_COPY
              : NEW_CONVERSATION_MEMORY_WARNING_COPY,
          });
        } catch {
          if (disposed || epoch !== resetEpoch) return;
          updateReset(() => hydrator.resetFailed(), {
            type: "reset-failed",
            announcement: NEW_CONVERSATION_UNCERTAIN_COPY,
          });
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
    answerDecision(decisionId, answer) {
      if (
        disposed ||
        resetBlocksWork() ||
        decisionContinuationTask !== undefined ||
        decision?.status !== "unanswered" ||
        decision.decisionId !== decisionId
      ) {
        return decisionContinuationTask ?? Promise.resolve();
      }
      return continueDecision("answerCoachDecision", decision, answer);
    },
    async skipDecision(decisionId) {
      if (
        disposed ||
        resetBlocksWork() ||
        decisionContinuationTask !== undefined ||
        decision?.status !== "unanswered" ||
        decision.decisionId !== decisionId
      ) {
        return;
      }
      decisionError = null;
      render();
      try {
        const client = await input.clients.getClient();
        const result = await client.call("skipCoachDecision", {
          chatId: DESKTOP_CHAT_ID,
          decisionId,
        });
        if (disposed || decision?.decisionId !== decisionId) return;
        decision = result.decision;
        decisionPhase = "idle";
        decisionAnswerLabel = null;
      } catch {
        if (disposed || decision?.decisionId !== decisionId) return;
        decisionError = CHAT_DECISION_SKIP_FAILURE_COPY;
      }
      render();
      if (!decisionBlocksWork()) void drain();
    },
    dispose() {
      disposed = true;
      activeStopRequest = undefined;
      hydrator.dispose();
      decision = null;
      epoch += 1;
      sequence += 1;
    },
  };
}
