import type { ReactElement } from "react";
import { TRANSCRIPT_HYDRATION_FAILURE_COPY } from "../../chat/hydration.js";
import { useEnduragentStore } from "../../state/store.js";
import styles from "./Transcript.module.css";

export function HistoryControls(): ReactElement {
  const status = useEnduragentStore((state) => state.chat.hydrationStatus);
  const hasEarlier = useEnduragentStore((state) => state.chat.hydrationHasEarlier);
  const workBlocked = useEnduragentStore((state) => state.chat.workBlocked);
  const actions = useEnduragentStore((state) => state.chatActions);

  const failed = status === "failed";
  const loadHidden = !hasEarlier || failed;
  const loadDisabled = status === "loading" || workBlocked;

  return (
    <div
      className={`${styles.controls} chat-history-controls`}
      aria-live="off"
      hidden={!hasEarlier && !failed}
    >
      <button
        type="button"
        className={`${styles.pill} chat-history-load`}
        hidden={loadHidden}
        disabled={loadDisabled}
        onClick={() => {
          if (loadHidden || loadDisabled) return;
          actions?.loadEarlier();
        }}
      >
        Load earlier messages
      </button>
      <p className={`${styles.failure} chat-history-failure`} hidden={!failed}>
        {TRANSCRIPT_HYDRATION_FAILURE_COPY}
      </p>
      <button
        type="button"
        className={`${styles.pill} chat-history-retry`}
        hidden={!failed}
        disabled={workBlocked}
        onClick={() => {
          if (!failed || workBlocked) return;
          actions?.retryHydration();
        }}
      >
        Retry history
      </button>
    </div>
  );
}
