import type { TurnEvent } from "@enduragent/coach-contract";

export const DESKTOP_CHAT_ID = "desktop" as const;

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
  readonly assistantMessageId: string;
  readonly draft: string;
  readonly finalText: string | null;
  readonly error: ChatErrorView | null;
}

export interface ChatTranscriptMessage {
  readonly id: string;
  readonly role: "athlete" | "coach";
  readonly text: string;
  readonly delivery: "complete" | "streaming" | "interrupted";
}

export interface ChatState {
  readonly status: ChatStatus;
  readonly messages: readonly ChatTranscriptMessage[];
  readonly activeTurn: ActiveTurn | null;
  readonly progress: string | null;
  readonly session: ChatSessionState;
}

export const EMPTY_CHAT_STATE: ChatState = {
  status: "idle",
  messages: [],
  activeTurn: null,
  progress: null,
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
  | { readonly type: "fail"; readonly requestKey: number; readonly copy: string }
  | { readonly type: "session-probe"; readonly hasSession: boolean }
  | { readonly type: "open-new-conversation" }
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

function assertNever(value: never): never {
  throw new TypeError(`Unhandled chat action: ${String(value)}`);
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
        progress: null,
        session: { ...state.session, announcement: null },
        activeTurn: {
          requestKey: action.requestKey,
          turnId: null,
          userMessage: action.userMessage,
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
        : { ...state, activeTurn: { ...active, turnId: action.turnId } };
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
            activeTurn: next,
            messages: updateAssistant(state, next, draft, "streaming"),
          };
        }
        case "final-text": {
          const next = { ...active, draft: action.event.text, finalText: action.event.text };
          return {
            ...state,
            activeTurn: next,
            messages: updateAssistant(state, next, action.event.text, "streaming"),
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
      if (active === null || active.finalText === null) return state;
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
        messages: updateAssistant(state, active, active.draft, "interrupted"),
      };
    }
    case "fail": {
      const active = current(state, action.requestKey);
      if (active === null) return state;
      return {
        ...state,
        status: "idle",
        progress: active.error === null ? action.copy : null,
        messages: updateAssistant(state, active, active.draft, "interrupted"),
      };
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
      return !hasClearableConversation(state) ||
        state.session.resetPhase !== "idle" ||
        state.status === "streaming"
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
