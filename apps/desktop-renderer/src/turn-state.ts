import type { TurnEvent } from "@enduragent/coach-contract";

export type AssistantDeliveryState =
  | { readonly status: "streaming"; readonly text: string }
  | { readonly status: "completed"; readonly text: string }
  | { readonly status: "aborted"; readonly text: string; readonly retryable: true }
  | { readonly status: "failed"; readonly message: string };

export interface ChatTurnState {
  readonly userText: string;
  readonly assistant: AssistantDeliveryState;
}

export type ChatTurnAction =
  | { readonly type: "event"; readonly event: TurnEvent }
  | { readonly type: "success"; readonly text: string }
  | { readonly type: "abort" }
  | { readonly type: "protocol-failure" }
  | { readonly type: "remote-failure" };

export function createChatTurn(userText: string): ChatTurnState {
  if (!/\S/u.test(userText)) throw new TypeError("chat text is empty");
  return { userText, assistant: { status: "streaming", text: "" } };
}

export function reduceChatTurn(state: ChatTurnState, action: ChatTurnAction): ChatTurnState {
  if (action.type === "event") {
    if (state.assistant.status !== "streaming") return state;
    if (action.event.type === "error") {
      return { ...state, assistant: { status: "failed", message: action.event.athleteMessage } };
    }
    if (action.event.type === "text_delta") {
      return {
        ...state,
        assistant: { status: "streaming", text: state.assistant.text + action.event.delta },
      };
    }
    if (action.event.type === "final-text") {
      return { ...state, assistant: { status: "streaming", text: action.event.text } };
    }
    return state;
  }
  if (action.type === "success") {
    if (state.assistant.status !== "streaming") return state;
    const currentText = state.assistant.text;
    return {
      ...state,
      assistant: {
        status: "completed",
        text: currentText.length === 0 ? action.text : currentText,
      },
    };
  }
  if (action.type === "abort") {
    if (state.assistant.status !== "streaming") return state;
    return {
      ...state,
      assistant: { status: "aborted", text: state.assistant.text, retryable: true },
    };
  }
  if (state.assistant.status === "completed" || state.assistant.status === "aborted") return state;
  return {
    ...state,
    assistant: {
      status: "failed",
      message:
        action.type === "protocol-failure"
          ? "The coaching connection returned an invalid response."
          : "Your coach could not complete this response.",
    },
  };
}
