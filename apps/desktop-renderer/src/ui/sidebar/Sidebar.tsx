import { useEffect, useRef, type ReactElement } from "react";
import { VIEWS } from "../../app/views.js";
import { registerNewConversationOpener } from "../../state/new-conversation-opener.js";
import { registerSetupOpener } from "../../state/setup-opener.js";
import { settingsMutationActive } from "../../state/settings-slice.js";
import { useEnduragentStore } from "../../state/store.js";
import { ConnectionStatus } from "./ConnectionStatus.js";
import { HistoryList } from "./HistoryList.js";
import styles from "./Sidebar.module.css";
import { SyncChip } from "./SyncChip.js";

export function Sidebar(): ReactElement {
  const activeView = useEnduragentStore((state) => state.activeView);
  const setActiveView = useEnduragentStore((state) => state.setActiveView);
  const unavailable = useEnduragentStore((state) => state.chat.newConversationUnavailable);
  const resetPhase = useEnduragentStore((state) => state.chat.resetPhase);
  const actions = useEnduragentStore((state) => state.chatActions);
  const settingsBusy = useEnduragentStore((state) => settingsMutationActive(state.settings));
  const opener = useRef<HTMLButtonElement>(null);
  const settingsNav = useRef<HTMLButtonElement>(null);
  const navigationLocked = activeView === "settings" && settingsBusy;

  useEffect(() => {
    registerNewConversationOpener(opener.current);
    registerSetupOpener(settingsNav.current);
    return () => {
      registerNewConversationOpener(null);
      registerSetupOpener(null);
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
          disabled={navigationLocked || actions === null || (unavailable && !focusableUncertain)}
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
            ref={view.id === "settings" ? settingsNav : undefined}
            className={view.id === activeView ? `${styles.navItem} ${styles.on}` : styles.navItem}
            aria-current={view.id === activeView ? "page" : undefined}
            disabled={navigationLocked && view.id !== activeView}
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
      <HistoryList locked={navigationLocked} />
      <div className={styles.railFoot}>
        <SyncChip />
        <ConnectionStatus />
      </div>
    </aside>
  );
}
