import { Activity, CalendarDays, Check, FileText, Image as ImageIcon, X } from "lucide-react";
import type { ReactElement } from "react";
import type {
  ChatChoiceView,
  ChatMessageView,
  ChatTranscriptItemView,
} from "../../state/chat-slice.js";
import { cn } from "../../lib/utils.js";
import { useEnduragentStore } from "../../state/store.js";
import { AthleteMessage } from "./AthleteMessage.js";
import { CoachMessage } from "./CoachMessage.js";
import { HistoryControls } from "./HistoryControls.js";
import { PlanReferenceCard } from "./PlanReferenceCard.js";
import { StreamingMessage } from "./StreamingMessage.js";

function MessageRow(props: {
  readonly message: ChatMessageView;
  readonly bufferedStreaming: boolean;
}): ReactElement {
  const message = props.message;
  const streaming = message.role === "coach" && message.delivery === "streaming";
  const silent = message.historical || message.role === "athlete";
  const rowClassName = cn(
    "chat-message grid min-w-0 data-[delivery=interrupted]:text-ink-2",
    message.role === "coach"
      ? "chat-message--coach max-w-full justify-self-start text-base leading-6"
      : "chat-message--athlete max-w-[76%] justify-self-end rounded-card rounded-br-ctl border border-line bg-surface px-4 py-3",
  );

  return (
    <article
      className={rowClassName}
      data-message-id={message.id}
      data-delivery={message.delivery}
      aria-live={silent ? "off" : undefined}
      aria-atomic={message.role === "coach" ? "true" : "false"}
      aria-busy={streaming ? "true" : undefined}
    >
      <span className="sr-only">
        {message.role === "athlete" ? "Your message" : "Coach response"}
      </span>
      {message.role === "athlete" ? (
        <div className="grid gap-2.5">
          {message.attachments?.map((attachment) => {
            const Icon =
              attachment.kind === "activity"
                ? Activity
                : attachment.kind === "workout"
                  ? CalendarDays
                  : attachment.kind === "image"
                    ? ImageIcon
                    : FileText;
            return (
              <div
                key={attachment.attachmentId}
                className="grid grid-cols-[32px_minmax(0,1fr)] items-center gap-2.5 rounded-md bg-bg-2 p-2.5"
              >
                <span className="flex size-8 items-center justify-center text-ink-2">
                  <Icon className="size-4" aria-hidden="true" />
                </span>
                <span className="min-w-0">
                  <strong className="block truncate text-sm leading-5">
                    {attachment.displayName}
                  </strong>
                  <small className="block text-xs leading-4 text-ink-2">
                    {attachment.extension.toUpperCase()}
                  </small>
                </span>
              </div>
            );
          })}
          {message.text.length === 0 ? null : <AthleteMessage text={message.text} />}
        </div>
      ) : streaming && props.bufferedStreaming ? (
        <StreamingMessage messageId={message.id} />
      ) : (
        <div className="min-w-0">
          <CoachMessage text={message.text} />
          {message.planReference === undefined ? null : (
            <PlanReferenceCard selection={message.planReference} />
          )}
        </div>
      )}
    </article>
  );
}

function ChoiceRow(props: { readonly choice: ChatChoiceView }): ReactElement {
  const choice = props.choice;
  return (
    <article
      className="grid grid-cols-[var(--ctl-h-sm)_minmax(0,1fr)] items-center gap-2.5 rounded-card bg-sunk p-3"
      aria-label="Choice consequence"
      aria-live={choice.historical ? "off" : undefined}
    >
      <span
        className={cn(
          "grid size-8 place-items-center rounded-full",
          choice.skipped ? "bg-surface-2 text-ink-2" : "bg-ok/16 text-ok",
        )}
      >
        {choice.skipped ? (
          <X className="size-4" aria-hidden="true" />
        ) : (
          <Check className="size-4" aria-hidden="true" />
        )}
      </span>
      <div className="grid gap-[calc(var(--inset)/2)]">
        <p className="m-0 text-xs font-semibold leading-4 text-ink-2">Choice consequence</p>
        <strong className="text-sm font-medium leading-5">{choice.label}</strong>
        {choice.consequence === null ? null : (
          <p className="m-0 text-xs leading-4 text-ink-2">{choice.consequence}</p>
        )}
      </div>
    </article>
  );
}

export function ConversationTranscript(props: {
  readonly messages: readonly ChatMessageView[];
  readonly timeline?: readonly ChatTranscriptItemView[];
  readonly historyControls?: boolean;
  readonly bufferedStreaming?: boolean;
}): ReactElement {
  const timeline = props.timeline ?? [];
  const messages = props.messages;
  const items =
    timeline.length > 0
      ? timeline
      : messages.map((message) => ({ kind: "message" as const, message }));

  return (
    <section
      className="chat-transcript grid gap-[18px]"
      role="log"
      aria-live="polite"
      aria-relevant="additions text"
      aria-atomic="false"
      aria-label="Coach conversation"
    >
      {props.historyControls === false ? null : <HistoryControls />}
      <div className="chat-messages grid gap-7">
        {items.length === 0 ? null : (
          <div className="contents">
            {items.map((item) =>
              item.kind === "message" ? (
                <MessageRow
                  key={`message:${item.message.id}`}
                  message={item.message}
                  bufferedStreaming={props.bufferedStreaming ?? false}
                />
              ) : (
                <ChoiceRow key={`choice:${item.choice.id}`} choice={item.choice} />
              ),
            )}
          </div>
        )}
      </div>
    </section>
  );
}

export function Transcript(): ReactElement {
  const timeline = useEnduragentStore((state) => state.chat.timeline);
  const messages = useEnduragentStore((state) => state.chat.messages);
  return <ConversationTranscript messages={messages} timeline={timeline} bufferedStreaming />;
}
