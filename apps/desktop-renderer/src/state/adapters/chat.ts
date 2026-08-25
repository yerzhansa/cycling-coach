import type { CoachDecisionReadModel, TranscriptPageEntry } from "@enduragent/coach-contract";
import type { ChatView, ChatViewControls } from "../../chat/controller.js";
import type { ChatState } from "../../turn-state.js";
import {
  EMPTY_CHAT_SURFACE,
  sameChatMessages,
  sameChatTimeline,
  sameChatQueued,
  sameChatSurface,
  type ChatMessageView,
  type ChatChoiceView,
  type ChatTranscriptItemView,
  type ChatQueuedView,
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
}

function isStreamingCoach(message: { readonly role: string; readonly delivery: string }): boolean {
  return message.role === "coach" && message.delivery === "streaming";
}

function choiceFromDecision(
  decision: CoachDecisionReadModel,
  historical: boolean,
): ChatChoiceView | null {
  if (decision.status === "skipped") {
    return {
      id: decision.decisionId,
      label: "Question skipped",
      consequence: "No coaching choice was applied.",
      skipped: true,
      historical,
    };
  }
  if (decision.status !== "answered" || decision.continuation.status !== "completed") return null;
  const answer = decision.answer;
  const label =
    answer.kind === "custom"
      ? answer.text
      : (decision.options.find((option) => option.id === answer.optionId)?.label ?? "Saved choice");
  return {
    id: decision.decisionId,
    label,
    consequence: answer.kind === "custom" ? null : decision.consequence,
    skipped: false,
    historical,
  };
}

function historicalTimeline(
  entries: readonly TranscriptPageEntry[],
  liveDecisionIds: ReadonlySet<string>,
): readonly ChatTranscriptItemView[] {
  const requested = new Map<string, CoachDecisionReadModel>();
  const timeline: ChatTranscriptItemView[] = [];
  for (const entry of entries) {
    if (entry.kind === "turn") {
      timeline.push(
        {
          kind: "message",
          message: {
            id: `history:athlete:${entry.turnId}`,
            turnId: entry.turnId,
            role: "athlete",
            delivery: "complete",
            historical: true,
            text: entry.athleteText,
          },
        },
        {
          kind: "message",
          message: {
            id: `history:coach:${entry.turnId}`,
            turnId: entry.turnId,
            role: "coach",
            delivery: "complete",
            historical: true,
            text: entry.coachText,
          },
        },
      );
      continue;
    }
    const decisionId =
      entry.kind === "decision-requested" ? entry.decision.decisionId : entry.decisionId;
    if (liveDecisionIds.has(decisionId)) continue;
    if (entry.kind === "decision-requested") {
      requested.set(entry.decision.decisionId, entry.decision);
      if (/\S/u.test(entry.athleteText)) {
        timeline.push({
          kind: "message",
          message: {
            id: `history:decision-athlete:${entry.decision.decisionId}`,
            role: "athlete",
            delivery: "complete",
            historical: true,
            text: entry.athleteText,
          },
        });
      }
      continue;
    }
    if (entry.kind === "decision-answered") {
      const source = requested.get(entry.decisionId);
      const answer = entry.answer;
      const label =
        answer.kind === "custom"
          ? answer.text
          : (source?.options.find((option) => option.id === answer.optionId)?.label ??
            "Saved choice");
      timeline.push({
        kind: "choice",
        choice: {
          id: entry.decisionId,
          label,
          consequence: answer.kind === "custom" ? null : entry.consequence,
          skipped: false,
          historical: true,
        },
      });
      continue;
    }
    if (entry.kind === "decision-skipped") {
      timeline.push({
        kind: "choice",
        choice: {
          id: entry.decisionId,
          label: "Question skipped",
          consequence: "No coaching choice was applied.",
          skipped: true,
          historical: true,
        },
      });
      continue;
    }
    if (entry.kind === "decision-continuation-completed" && /\S/u.test(entry.coachText)) {
      timeline.push({
        kind: "message",
        message: {
          id: `history:decision-coach:${entry.continuationId}`,
          turnId: entry.turnId,
          role: "coach",
          delivery: "complete",
          historical: true,
          text: entry.coachText,
        },
      });
    }
  }
  return timeline;
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
      ...(message.turnId === undefined ? {} : { turnId: message.turnId }),
      ...(message.decisionId === undefined ? {} : { decisionId: message.decisionId }),
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
    const decision = controls?.decision;
    const queued: readonly ChatQueuedView[] = state.queued.map((message) => ({
      id: message.id,
      text: message.text,
      command: message.command,
    }));
    const liveDecisionIds = new Set(
      messages.flatMap((message) => (message.decisionId === undefined ? [] : [message.decisionId])),
    );
    const historicalItems = historicalTimeline(hydration?.entries ?? [], liveDecisionIds);
    const historicalMessageIds = new Set(
      historicalItems.flatMap((item) => (item.kind === "message" ? [item.message.id] : [])),
    );
    const liveItems: ChatTranscriptItemView[] = messages
      .filter((message) => !historicalMessageIds.has(message.id))
      .map((message) => ({ kind: "message", message }));
    const liveChoice =
      decision?.value === null || decision === undefined
        ? null
        : choiceFromDecision(decision.value, false);
    if (liveChoice !== null) {
      const duplicate = historicalItems.findIndex(
        (item) => item.kind === "choice" && item.choice.id === liveChoice.id,
      );
      if (duplicate === -1) {
        const continuationTurnId =
          decision?.value?.status === "answered" &&
          decision.value.continuation.status === "completed"
            ? decision.value.continuation.turnId
            : null;
        const continuationIndex = liveItems.findIndex(
          (item) =>
            item.kind === "message" &&
            item.message.role === "coach" &&
            item.message.turnId === continuationTurnId,
        );
        const choiceItem: ChatTranscriptItemView = { kind: "choice", choice: liveChoice };
        if (continuationIndex === -1) liveItems.push(choiceItem);
        else liveItems.splice(continuationIndex, 0, choiceItem);
      }
    }
    const timeline = [...historicalItems, ...liveItems];
    const decisionBlocksWork =
      decision?.value?.status === "unanswered" ||
      (decision?.value?.status === "answered" && decision.value.continuation.status === "pending");
    const decisionLoading = controls?.decisionLoading === true;
    const decisionLoadError = controls?.decisionLoadError ?? null;
    const decisionUnavailable = decisionLoading || decisionLoadError !== null;
    return {
      messages: sameChatMessages(published.messages, messages) ? published.messages : messages,
      queued: sameChatQueued(published.queued, queued) ? published.queued : queued,
      decision: decision?.value ?? null,
      decisionPhase: decision?.phase ?? "idle",
      decisionAnswerLabel: decision?.answerLabel ?? null,
      decisionError: decision?.error ?? null,
      decisionLoadError,
      timeline: sameChatTimeline(published.timeline, timeline) ? published.timeline : timeline,
      status: state.status,
      notice:
        state.activeTurn?.error?.athleteMessage ??
        (state.status === "streaming" ? null : state.progress),
      coachProgress:
        state.status === "streaming" && state.activeTurn?.error === null ? state.progress : null,
      interrupted: state.status === "interrupted",
      workBlocked,
      sendDisabled: workBlocked || decisionBlocksWork || decisionUnavailable,
      inputDisabled: workBlocked,
      newConversationUnavailable: newConversationUnavailable || decisionUnavailable,
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
  };
}
