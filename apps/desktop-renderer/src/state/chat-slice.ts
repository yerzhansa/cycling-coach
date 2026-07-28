import type { StateCreator } from "zustand";
import type { TranscriptHydrationChange, TranscriptHydrationStatus } from "../chat/hydration.js";
import type { FirstSyncState } from "../first-sync.js";
import type { ChatStatus, ChatTranscriptMessage, SessionResetPhase } from "../turn-state.js";
import type { EnduragentState } from "./store.js";

export interface ChatMessageView {
  readonly id: string;
  readonly role: ChatTranscriptMessage["role"];
  readonly delivery: ChatTranscriptMessage["delivery"];
  readonly historical: boolean;
  readonly text: string;
}

export interface ChatSurfaceState {
  readonly messages: readonly ChatMessageView[];
  readonly status: ChatStatus;
  readonly notice: string | null;
  readonly interrupted: boolean;
  readonly workBlocked: boolean;
  readonly composerDisabled: boolean;
  readonly newConversationUnavailable: boolean;
  readonly resetPhase: SessionResetPhase;
  readonly resetCount: number;
  readonly announcement: string | null;
  readonly hasHydratedHistory: boolean;
  readonly hydrationStatus: TranscriptHydrationStatus;
  readonly hydrationHasEarlier: boolean;
  readonly hydrationRevision: number;
  readonly hydrationChange: TranscriptHydrationChange;
}

export interface ChatActions {
  submit(message: string): void;
  retry(): void;
  loadEarlier(): void;
  retryHydration(): void;
  openNewConversation(): void;
  cancelNewConversation(): void;
  confirmNewConversation(): void;
  retryFirstSync(): void;
}

export const EMPTY_CHAT_SURFACE: ChatSurfaceState = Object.freeze({
  messages: Object.freeze([]),
  status: "idle",
  notice: null,
  interrupted: false,
  workBlocked: false,
  composerDisabled: false,
  newConversationUnavailable: true,
  resetPhase: "idle",
  resetCount: 0,
  announcement: null,
  hasHydratedHistory: false,
  hydrationStatus: "idle",
  hydrationHasEarlier: false,
  hydrationRevision: 0,
  hydrationChange: "none",
});

export const IDLE_FIRST_SYNC: FirstSyncState = Object.freeze({ status: "idle" });

export interface ChatSlice {
  readonly chat: ChatSurfaceState;
  readonly chatActions: ChatActions | null;
  readonly firstSync: FirstSyncState;
  setChatSurface: (next: ChatSurfaceState) => void;
  setFirstSync: (next: FirstSyncState) => void;
  bindChatActions: (actions: ChatActions | null) => void;
}

export function sameChatMessages(
  left: readonly ChatMessageView[],
  right: readonly ChatMessageView[],
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((message, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      message.id === other.id &&
      message.role === other.role &&
      message.delivery === other.delivery &&
      message.historical === other.historical &&
      message.text === other.text
    );
  });
}

export function sameChatSurface(left: ChatSurfaceState, right: ChatSurfaceState): boolean {
  return (
    left.status === right.status &&
    left.notice === right.notice &&
    left.interrupted === right.interrupted &&
    left.workBlocked === right.workBlocked &&
    left.composerDisabled === right.composerDisabled &&
    left.newConversationUnavailable === right.newConversationUnavailable &&
    left.resetPhase === right.resetPhase &&
    left.resetCount === right.resetCount &&
    left.announcement === right.announcement &&
    left.hasHydratedHistory === right.hasHydratedHistory &&
    left.hydrationStatus === right.hydrationStatus &&
    left.hydrationHasEarlier === right.hydrationHasEarlier &&
    left.hydrationRevision === right.hydrationRevision &&
    left.hydrationChange === right.hydrationChange &&
    sameChatMessages(left.messages, right.messages)
  );
}

export const createChatSlice: StateCreator<EnduragentState, [], [], ChatSlice> = (set) => ({
  chat: EMPTY_CHAT_SURFACE,
  chatActions: null,
  firstSync: IDLE_FIRST_SYNC,
  setChatSurface(next) {
    set({ chat: next });
  },
  setFirstSync(next) {
    set({ firstSync: next });
  },
  bindChatActions(actions) {
    set({ chatActions: actions });
  },
});
