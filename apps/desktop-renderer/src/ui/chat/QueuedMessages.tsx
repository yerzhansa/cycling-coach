import type { ReactElement } from "react";
import { useEnduragentStore } from "../../state/store.js";
import styles from "./QueuedMessages.module.css";

export function QueuedMessages(): ReactElement | null {
  const queued = useEnduragentStore((state) => state.chat.queued);
  const workBlocked = useEnduragentStore((state) => state.chat.workBlocked);
  const actions = useEnduragentStore((state) => state.chatActions);

  if (queued.length === 0) return null;

  return (
    <section className={`${styles.host} chat-queue`} aria-label="Queued messages">
      <p className={`${styles.caption} chat-queue__caption`}>Queued to send next</p>
      <ul className={styles.list} role="list">
        {queued.map((message, index) => (
          <li key={message.id} className={`${styles.item} chat-queue__item`}>
            <span
              className={
                message.command
                  ? `${styles.text} ${styles.command} chat-queue__text`
                  : `${styles.text} chat-queue__text`
              }
            >
              {message.text}
            </span>
            <button
              type="button"
              className={`${styles.remove} chat-queue__remove`}
              aria-label={`Remove queued message ${index + 1}`}
              disabled={workBlocked || actions === null}
              onClick={() => {
                actions?.removeQueued(message.id);
              }}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
