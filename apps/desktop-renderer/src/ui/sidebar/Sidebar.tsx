import type { ReactElement } from "react";
import { startLegacyNewConversation } from "../../app/legacy-actions.js";
import { VIEWS } from "../../app/views.js";
import { useEnduragentStore } from "../../state/store.js";
import styles from "./Sidebar.module.css";

const NEW_CHAT_UNAVAILABLE_HINT = "Available once the coach connection finishes starting up";

export function Sidebar(): ReactElement {
  const activeView = useEnduragentStore((state) => state.activeView);
  const setActiveView = useEnduragentStore((state) => state.setActiveView);
  const legacyReady = useEnduragentStore((state) => state.legacyReady);

  return (
    <aside className={styles.rail}>
      <div className={styles.railTop}>
        <div className={styles.brand}>Enduragent</div>
        <button
          type="button"
          className={styles.newButton}
          disabled={!legacyReady}
          title={legacyReady ? undefined : NEW_CHAT_UNAVAILABLE_HINT}
          onClick={() => {
            setActiveView("chat");
            startLegacyNewConversation();
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
            className={
              view.id === activeView ? `${styles.navItem} ${styles.on}` : styles.navItem
            }
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
          className={
            activeView === "chat" ? `${styles.histItem} ${styles.on}` : styles.histItem
          }
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
