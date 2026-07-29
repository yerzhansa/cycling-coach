import type { ReactElement } from "react";
import { useEnduragentStore } from "../../state/store.js";
import styles from "./Sidebar.module.css";

interface ConversationEntry {
  readonly id: string;
  readonly title: string;
  readonly when: string;
}

const LIVE_CONVERSATION_ID = "desktop";

const SINGLE_CONVERSATION_NOTE = "Enduragent keeps one conversation on this Mac.";

export function HistoryList(props: { readonly locked: boolean }): ReactElement {
  const activeView = useEnduragentStore((store) => store.activeView);
  const setActiveView = useEnduragentStore((store) => store.setActiveView);
  const entries: readonly ConversationEntry[] = [
    { id: LIVE_CONVERSATION_ID, title: "Current conversation", when: "Live" },
  ];

  return (
    <div className={styles.hist}>
      {entries.map((entry) => (
        <button
          key={entry.id}
          type="button"
          className={activeView === "chat" ? `${styles.histItem} ${styles.on}` : styles.histItem}
          aria-current={activeView === "chat" ? "true" : undefined}
          disabled={props.locked}
          onClick={() => {
            setActiveView("chat");
          }}
        >
          <span className={styles.histTitle}>{entry.title}</span>
          <span className={styles.histWhen}>{entry.when}</span>
        </button>
      ))}
      <p className={styles.histNote}>{SINGLE_CONVERSATION_NOTE}</p>
    </div>
  );
}
