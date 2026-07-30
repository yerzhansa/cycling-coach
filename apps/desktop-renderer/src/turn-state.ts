import type { TurnEvent } from "@enduragent/coach-contract";
import { isSlashCommandText } from "./chat/commands.js";

export const DESKTOP_CHAT_ID = "desktop" as const;
export const CHAT_WORKING_COPY = "Coach is working…";
export const QUEUED_MESSAGE_SEPARATOR = "\n\n";

export type ChatStatus = "idle" | "streaming" | "interrupted";
export type SessionPresence = "unknown" | "absent" | "present";
export type SessionResetPhase = "idle" | "confirming" | "resetting" | "uncertain";

export interface ChatSessionState {
  readonly presence: SessionPresence;
  readonly resetPhase: SessionResetPhase;
  readonly resetCount: number;
  readonly announcement: string | null;
}

export interface ChatErrorView {
  readonly kind: Extract<TurnEvent, { type: "error" }>["kind"];
  readonly athleteMessage: string;
}

export interface ActiveTurn {
  readonly requestKey: number;
  readonly turnId: string | null;
  readonly userMessage: string;
  readonly userMessageId: string | null;
  readonly assistantMessageId: string;
  readonly draft: string;
  readonly finalText: string | null;
  readonly error: ChatErrorView | null;
}

export interface ChatTranscriptMessage {
  readonly id: string;
  readonly turnId?: string;
  readonly role: "athlete" | "coach";
  readonly text: string;
  readonly delivery: "complete" | "streaming" | "interrupted";
  readonly historical?: boolean;
}

export interface QueuedMessage {
  readonly id: string;
  readonly text: string;
  readonly command: boolean;
}

export interface ChatDrainGroup {
  readonly size: number;
  readonly text: string;
}

export interface ChatState {
  readonly status: ChatStatus;
  readonly messages: readonly ChatTranscriptMessage[];
  readonly activeTurn: ActiveTurn | null;
  readonly progress: string | null;
  readonly queued: readonly QueuedMessage[];
  readonly session: ChatSessionState;
}

export const EMPTY_CHAT_STATE: ChatState = {
  status: "idle",
  messages: [],
  activeTurn: null,
  progress: null,
  queued: [],
  session: {
    presence: "unknown",
    resetPhase: "idle",
    resetCount: 0,
    announcement: null,
  },
};

export type ChatAction =
  | {
      readonly type: "submit";
      readonly requestKey: number;
      readonly userMessage: string;
      readonly userMessageId: string;
      readonly assistantMessageId: string;
      readonly includeUser: boolean;
    }
  | { readonly type: "bind-turn"; readonly requestKey: number; readonly turnId: string }
  | { readonly type: "event"; readonly requestKey: number; readonly event: TurnEvent }
  | { readonly type: "complete"; readonly requestKey: number }
  | { readonly type: "interrupt"; readonly requestKey: number; readonly copy: string }
  | { readonly type: "retry-pending"; readonly requestKey: number }
  | { readonly type: "fail"; readonly requestKey: number; readonly copy: string }
  | { readonly type: "enqueue"; readonly id: string; readonly text: string }
  | { readonly type: "remove-queued"; readonly id: string }
  | { readonly type: "dequeue-group" }
  | { readonly type: "session-probe"; readonly hasSession: boolean }
  | { readonly type: "open-new-conversation"; readonly hasHydratedHistory?: boolean }
  | { readonly type: "cancel-new-conversation" }
  | { readonly type: "begin-reset" }
  | { readonly type: "reset-succeeded"; readonly announcement: string }
  | { readonly type: "reset-failed"; readonly announcement: string };

function current(state: ChatState, requestKey: number): ActiveTurn | null {
  return state.activeTurn?.requestKey === requestKey ? state.activeTurn : null;
}

function updateAssistant(
  state: ChatState,
  activeTurn: ActiveTurn,
  text: string,
  delivery: ChatTranscriptMessage["delivery"],
): readonly ChatTranscriptMessage[] {
  return state.messages.map((message) =>
    message.id === activeTurn.assistantMessageId ? { ...message, text, delivery } : message,
  );
}

function visibleDraft(draft: string): string {
  return /\S/u.test(draft) ? draft : "";
}

function clearGenericProgress(progress: string | null, text: string): string | null {
  return progress === CHAT_WORKING_COPY && /\S/u.test(text) ? null : progress;
}

function assertNever(value: never): never {
  throw new TypeError(`Unhandled chat action: ${String(value)}`);
}

export function nextDrainGroup(state: ChatState): ChatDrainGroup | null {
  const head = state.queued[0];
  if (head === undefined) return null;
  let size = 1;
  if (!head.command) {
    while (state.queued[size]?.command === false) size += 1;
  }
  return {
    size,
    text: state.queued
      .slice(0, size)
      .map((message) => message.text)
      .join(QUEUED_MESSAGE_SEPARATOR),
  };
}

export function hasClearableConversation(state: ChatState): boolean {
  return (
    state.session.presence === "present" ||
    state.messages.some((message) => message.role === "athlete" || /\S/u.test(message.text))
  );
}

export function reduceChatState(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "submit": {
      if (state.status === "streaming") return state;
      const assistant: ChatTranscriptMessage = {
        id: action.assistantMessageId,
        role: "coach",
        text: "",
        delivery: "streaming",
      };
      const messages = action.includeUser
        ? [
            ...state.messages,
            {
              id: action.userMessageId,
              role: "athlete" as const,
              text: action.userMessage,
              delivery: "complete" as const,
            },
            assistant,
          ]
        : [...state.messages, assistant];
      return {
        status: "streaming",
        messages,
        progress: CHAT_WORKING_COPY,
        queued: state.queued,
        session: { ...state.session, announcement: null },
        activeTurn: {
          requestKey: action.requestKey,
          turnId: null,
          userMessage: action.userMessage,
          userMessageId: action.includeUser ? action.userMessageId : null,
          assistantMessageId: action.assistantMessageId,
          draft: "",
          finalText: null,
          error: null,
        },
      };
    }
    case "bind-turn": {
      const active = current(state, action.requestKey);
      return active === null
        ? state
        : {
            ...state,
            messages: state.messages.map((message) =>
              message.id === active.userMessageId || message.id === active.assistantMessageId
                ? { ...message, turnId: action.turnId }
                : message,
            ),
            activeTurn: { ...active, turnId: action.turnId },
          };
    }
    case "event": {
      const active = current(state, action.requestKey);
      if (active === null || state.status !== "streaming") return state;
      switch (action.event.type) {
        case "turn-start":
          return state;
        case "text_delta": {
          const draft = active.draft + action.event.delta;
          const next = { ...active, draft };
          return {
            ...state,
            progress: clearGenericProgress(state.progress, action.event.delta),
            activeTurn: next,
            messages: /\S/u.test(draft)
              ? updateAssistant(state, next, draft, "streaming")
              : state.messages,
          };
        }
        case "final-text": {
          const hasText = /\S/u.test(action.event.text);
          const next = {
            ...active,
            draft: hasText ? action.event.text : active.draft,
            finalText: action.event.text,
          };
          return {
            ...state,
            progress: clearGenericProgress(state.progress, action.event.text),
            activeTurn: next,
            messages: hasText
              ? updateAssistant(state, next, action.event.text, "streaming")
              : state.messages,
          };
        }
        case "error":
          return {
            ...state,
            activeTurn: {
              ...active,
              error: { kind: action.event.kind, athleteMessage: action.event.athleteMessage },
            },
          };
        case "tool-start":
        case "tool-end":
        case "step-text":
          return { ...state, progress: "Checking your training data…" };
        default:
          return assertNever(action.event);
      }
    }
    case "complete": {
      const active = current(state, action.requestKey);
      if (active === null || active.finalText === null || !/\S/u.test(active.finalText))
        return state;
      return {
        ...state,
        status: "idle",
        progress: null,
        session: { ...state.session, presence: "present" },
        messages: updateAssistant(state, active, active.finalText, "complete"),
      };
    }
    case "interrupt": {
      const active = current(state, action.requestKey);
      if (active === null) return state;
      return {
        ...state,
        status: "interrupted",
        progress: action.copy,
        messages: updateAssistant(state, active, visibleDraft(active.draft), "interrupted"),
      };
    }
    case "retry-pending": {
      const active = current(state, action.requestKey);
      return active === null || state.status !== "interrupted"
        ? state
        : {
            ...state,
            progress: CHAT_WORKING_COPY,
            activeTurn: { ...active, error: null },
          };
    }
    case "fail": {
      const active = current(state, action.requestKey);
      if (active === null) return state;
      return {
        ...state,
        status: "idle",
        progress: active.error === null ? action.copy : null,
        messages: updateAssistant(state, active, visibleDraft(active.draft), "interrupted"),
      };
    }
    case "enqueue": {
      if (!/\S/u.test(action.text) || state.queued.some((message) => message.id === action.id)) {
        return state;
      }
      return {
        ...state,
        queued: [
          ...state.queued,
          { id: action.id, text: action.text, command: isSlashCommandText(action.text) },
        ],
      };
    }
    case "remove-queued": {
      const queued = state.queued.filter((message) => message.id !== action.id);
      return queued.length === state.queued.length ? state : { ...state, queued };
    }
    case "dequeue-group": {
      const group = nextDrainGroup(state);
      return group === null ? state : { ...state, queued: state.queued.slice(group.size) };
    }
    case "session-probe": {
      if (state.session.resetPhase !== "idle") return state;
      if (!action.hasSession && state.session.presence === "present") {
        return state;
      }
      return {
        ...state,
        session: {
          ...state.session,
          presence: action.hasSession ? "present" : "absent",
        },
      };
    }
    case "open-new-conversation":
      return (!action.hasHydratedHistory && !hasClearableConversation(state)) ||
        state.session.resetPhase !== "idle" ||
        state.status === "streaming" ||
        state.queued.length > 0
        ? state
        : {
            ...state,
            session: { ...state.session, resetPhase: "confirming" },
          };
    case "cancel-new-conversation":
      return state.session.resetPhase !== "confirming"
        ? state
        : {
            ...state,
            session: { ...state.session, resetPhase: "idle" },
          };
    case "begin-reset":
      return state.session.resetPhase !== "confirming"
        ? state
        : {
            ...state,
            session: { ...state.session, resetPhase: "resetting" },
          };
    case "reset-succeeded":
      return state.session.resetPhase !== "resetting"
        ? state
        : {
            status: "idle",
            messages: [],
            activeTurn: null,
            progress: null,
            queued: [],
            session: {
              presence: "absent",
              resetPhase: "idle",
              resetCount: state.session.resetCount + 1,
              announcement: action.announcement,
            },
          };
    case "reset-failed":
      return state.session.resetPhase !== "resetting"
        ? state
        : {
            ...state,
            session: {
              ...state.session,
              resetPhase: "uncertain",
              announcement: action.announcement,
            },
          };
    default:
      return assertNever(action);
  }
}
