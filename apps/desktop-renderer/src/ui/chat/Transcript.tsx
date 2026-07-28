import type { ReactElement } from "react";
import type { ChatMessageView } from "../../state/chat-slice.js";
import { useEnduragentStore } from "../../state/store.js";
import { AthleteMessage } from "./AthleteMessage.js";
import { CoachMessage } from "./CoachMessage.js";
import { Notice, RetryBar } from "./Notice.js";
import { HistoryControls } from "./HistoryControls.js";
import { StreamingMessage } from "./StreamingMessage.js";
import styles from "./Transcript.module.css";

function MessageRow(props: { readonly message: ChatMessageView }): ReactElement {
  const message = props.message;
  const streaming = message.role === "coach" && message.delivery === "streaming";
  const silent = message.historical || message.role === "athlete";
  const rowClassName =
    message.role === "coach"
      ? `chat-message chat-message--coach ${styles.prose}`
      : "chat-message chat-message--athlete";

  return (
    <article
      className={rowClassName}
      data-message-id={message.id}
      data-delivery={message.delivery}
      aria-live={silent ? "off" : undefined}
      aria-atomic={message.role === "coach" ? "true" : "false"}
      aria-busy={streaming ? "true" : undefined}
    >
      <p className="chat-message__role">{message.role === "athlete" ? "You" : "Coach"}</p>
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
      className="chat-transcript"
      role="log"
      aria-live="polite"
      aria-relevant="additions text"
      aria-atomic="false"
      aria-label="Coach conversation"
    >
      <HistoryControls />
      <div className="chat-messages">
        {messages.length === 0 ? null : (
          <div className={styles.page}>
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
