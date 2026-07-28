import type { ChatView, ChatViewControls } from "../../chat/controller.js";
import type { ChatState } from "../../turn-state.js";
import {
  EMPTY_CHAT_SURFACE,
  sameChatMessages,
  sameChatSurface,
  type ChatMessageView,
  type ChatSurfaceState,
} from "../chat-slice.js";
import {
  chatScrollAnchor,
  chatStreamBuffer,
  type ChatScrollAnchor,
  type ChatStreamBuffer,
} from "../chat-stream.js";

type StreamAction =
  | { readonly kind: "append"; readonly messageId: string; readonly delta: string }
  | { readonly kind: "set"; readonly messageId: string; readonly text: string };

export interface ChatViewAdapter {
  readonly view: ChatView;
  reset(): void;
}

function isStreamingCoach(message: {
  readonly role: string;
  readonly delivery: string;
}): boolean {
  return message.role === "coach" && message.delivery === "streaming";
}

export function createChatViewAdapter(input: {
  readonly publish: (next: ChatSurfaceState) => void;
  readonly buffer?: ChatStreamBuffer;
  readonly anchor?: ChatScrollAnchor;
}): ChatViewAdapter {
  const buffer = input.buffer ?? chatStreamBuffer;
  const anchor = input.anchor ?? chatScrollAnchor;
  let published = EMPTY_CHAT_SURFACE;

  const project = (state: ChatState, controls: ChatViewControls | undefined): ChatSurfaceState => {
    const visible = state.messages.filter(
      (message) => message.role === "athlete" || message.text.length > 0,
    );
    const messages: readonly ChatMessageView[] = visible.map((message) => ({
      id: message.id,
      role: message.role,
      delivery: message.delivery,
      historical: message.historical === true,
      text: isStreamingCoach(message) ? "" : message.text,
    }));
    const workBlocked =
      controls?.workBlocked ??
      (state.session.resetPhase === "confirming" || state.session.resetPhase === "resetting");
    const newConversationUnavailable =
      controls?.newConversationDisabled ??
      (state.session.presence !== "present" ||
        state.session.resetPhase !== "idle" ||
        state.status === "streaming");
    const hydration = controls?.hydration;
    return {
      messages: sameChatMessages(published.messages, messages) ? published.messages : messages,
      status: state.status,
      notice: state.activeTurn?.error?.athleteMessage ?? state.progress,
      interrupted: state.status === "interrupted",
      workBlocked,
      composerDisabled: state.status === "streaming" || workBlocked,
      newConversationUnavailable,
      resetPhase: state.session.resetPhase,
      resetCount: state.session.resetCount,
      announcement: state.session.announcement,
      hasHydratedHistory: messages.some((message) => message.historical),
      hydrationStatus: hydration?.status ?? "idle",
      hydrationHasEarlier: hydration?.hasEarlier ?? false,
      hydrationRevision: hydration?.revision ?? 0,
      hydrationChange: hydration?.change ?? "none",
    };
  };

  const planStream = (
    state: ChatState,
    controls: ChatViewControls | undefined,
  ): { readonly action: StreamAction | null; readonly streaming: ReadonlySet<string> } => {
    const streaming = new Set<string>();
    let action: StreamAction | null = null;
    for (const message of state.messages) {
      if (!isStreamingCoach(message) || message.text.length === 0) continue;
      streaming.add(message.id);
      const buffered = buffer.read(message.id);
      const appendDelta = controls?.appendDelta;
      if (
        appendDelta !== undefined &&
        appendDelta.messageId === message.id &&
        appendDelta.previousTextLength === buffered.length &&
        appendDelta.nextTextLength === message.text.length &&
        appendDelta.nextTextLength === appendDelta.previousTextLength + appendDelta.delta.length
      ) {
        action = { kind: "append", messageId: message.id, delta: appendDelta.delta };
      } else if (buffered !== message.text) {
        action = { kind: "set", messageId: message.id, text: message.text };
      }
    }
    return { action, streaming };
  };

  return {
    view: {
      render(state, controls) {
        const identifiers = new Set(state.messages.map((message) => message.id));
        if (identifiers.size !== state.messages.length) {
          throw new TypeError("duplicate chat message id");
        }
        const next = project(state, controls);
        const { action, streaming } = planStream(state, controls);
        const changed = !sameChatSurface(published, next);
        if (!changed && action === null) return;
        anchor.capture();
        if (action?.kind === "append") buffer.append(action.messageId, action.delta);
        else if (action?.kind === "set") buffer.set(action.messageId, action.text);
        buffer.retain(streaming);
        if (!changed) {
          anchor.apply({ hydrationChanged: false, hydrationChange: "none" });
          return;
        }
        published = next;
        input.publish(next);
      },
    },
    reset() {
      published = EMPTY_CHAT_SURFACE;
    },
  };
}
