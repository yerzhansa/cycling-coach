import type { ReactElement } from "react";
import type { ChatMessageView } from "../../state/chat-slice.js";
import { cn } from "../../lib/utils.js";
import { useEnduragentStore } from "../../state/store.js";
import { AthleteMessage } from "./AthleteMessage.js";
import { CoachMessage } from "./CoachMessage.js";
import { Notice, RetryBar } from "./Notice.js";
import { HistoryControls } from "./HistoryControls.js";
import { StreamingMessage } from "./StreamingMessage.js";

function MessageRow(props: { readonly message: ChatMessageView }): ReactElement {
  const message = props.message;
  const streaming = message.role === "coach" && message.delivery === "streaming";
  const silent = message.historical || message.role === "athlete";
  const rowClassName = cn(
    "chat-message grid min-w-0 max-w-[78%] gap-[7px] data-[delivery=interrupted]:text-ink-2",
    message.role === "coach"
      ? "chat-message--coach justify-self-start text-base leading-[1.6] tracking-[0.002em]"
      : "chat-message--athlete justify-self-end rounded-card rounded-br-ctl border border-line bg-surface px-4 py-3",
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
      <p className="chat-message__role m-0 text-xs leading-[1.2] tracking-[0.04em] text-ink-3 uppercase">
        {message.role === "athlete" ? "You" : "Coach"}
      </p>
      {message.role === "athlete" ? (
        <AthleteMessage text={message.text} />
      ) : streaming ? (
        <StreamingMessage messageId={message.id} />
      ) : (
        <CoachMessage text={message.text} />
      )}
    </article>
  );
}

export function Transcript(): ReactElement {
  const messages = useEnduragentStore((state) => state.chat.messages);

  return (
    <section
      className="chat-transcript grid gap-[18px]"
      role="log"
      aria-live="polite"
      aria-relevant="additions text"
      aria-atomic="false"
      aria-label="Coach conversation"
    >
      <HistoryControls />
      <div className="chat-messages grid gap-7">
        {messages.length === 0 ? null : (
          <div className="contents">
            {messages.map((message) => (
              <MessageRow key={message.id} message={message} />
            ))}
          </div>
        )}
      </div>
      <Notice />
      <RetryBar />
    </section>
  );
}
