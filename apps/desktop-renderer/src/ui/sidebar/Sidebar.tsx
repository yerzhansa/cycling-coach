import { useEffect, useRef, type ReactElement } from "react";
import { VIEWS } from "../../app/views.js";
import { registerNewConversationOpener } from "../../state/new-conversation-opener.js";
import { useEnduragentStore } from "../../state/store.js";
import styles from "./Sidebar.module.css";

export function Sidebar(): ReactElement {
  const activeView = useEnduragentStore((state) => state.activeView);
  const setActiveView = useEnduragentStore((state) => state.setActiveView);
  const unavailable = useEnduragentStore((state) => state.chat.newConversationUnavailable);
  const resetPhase = useEnduragentStore((state) => state.chat.resetPhase);
  const actions = useEnduragentStore((state) => state.chatActions);
  const opener = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    registerNewConversationOpener(opener.current);
    return () => {
      registerNewConversationOpener(null);
    };
  }, []);

  const focusableUncertain = unavailable && resetPhase === "uncertain";

  return (
    <aside className={styles.rail}>
      <div className={styles.railTop}>
        <div className={styles.brand}>Enduragent</div>
        <button
          type="button"
          ref={opener}
          className={`${styles.newButton} new-conversation-button`}
          disabled={actions === null || (unavailable && !focusableUncertain)}
          aria-disabled={focusableUncertain ? "true" : undefined}
          onClick={() => {
            if (focusableUncertain) return;
            setActiveView("chat");
            actions?.openNewConversation();
          }}
        >
          <span className={styles.plus} aria-hidden="true">
            ＋
          </span>
          New chat
        </button>
      </div>
      <nav className={styles.nav} aria-label="Main navigation">
        {VIEWS.map((view) => (
          <button
            key={view.id}
            type="button"
            className={view.id === activeView ? `${styles.navItem} ${styles.on}` : styles.navItem}
            aria-current={view.id === activeView ? "page" : undefined}
            onClick={() => {
              setActiveView(view.id);
            }}
          >
            <span className={styles.glyph} aria-hidden="true">
              {view.glyph}
            </span>
            {view.label}
          </button>
        ))}
      </nav>
      <div className={styles.sec}>Conversations</div>
      <div className={styles.hist}>
        <button
          type="button"
          className={activeView === "chat" ? `${styles.histItem} ${styles.on}` : styles.histItem}
          onClick={() => {
            setActiveView("chat");
          }}
        >
          <span className={styles.histTitle}>Current conversation</span>
          <span className={styles.histWhen}>Live</span>
        </button>
      </div>
      <div className={styles.railFoot}>
        <p className={styles.sync}>
          <span className={styles.dot} aria-hidden="true" />
          Sync status moves here with the training page
        </p>
      </div>
    </aside>
  );
}
