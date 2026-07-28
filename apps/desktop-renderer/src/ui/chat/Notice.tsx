import type { ReactElement } from "react";
import { useEnduragentStore } from "../../state/store.js";
import styles from "./Transcript.module.css";

export function Notice(): ReactElement {
  const notice = useEnduragentStore((state) => state.chat.notice);
  return (
    <p className={`${styles.notice} chat-notice`} hidden={notice === null}>
      {notice ?? ""}
    </p>
  );
}

export function RetryBar(): ReactElement {
  const interrupted = useEnduragentStore((state) => state.chat.interrupted);
  const workBlocked = useEnduragentStore((state) => state.chat.workBlocked);
  const actions = useEnduragentStore((state) => state.chatActions);

  return (
    <button
      type="button"
      className={`${styles.pill} chat-retry`}
      hidden={!interrupted}
      disabled={workBlocked}
      onClick={() => {
        if (!interrupted || workBlocked) return;
        actions?.retry();
      }}
    >
      Retry message
    </button>
  );
}
