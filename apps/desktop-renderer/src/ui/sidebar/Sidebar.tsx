import { Plus } from "lucide-react";
import { useEffect, useRef, type ReactElement } from "react";
import { VIEWS } from "../../app/views.js";
import { registerNewConversationOpener } from "../../state/new-conversation-opener.js";
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
  const onboardingOpen = useEnduragentStore((state) => state.onboarding.open);
  const onboardingActions = useEnduragentStore((state) => state.onboardingActions);
  const settingsBusy = useEnduragentStore((state) => settingsMutationActive(state.settings));
  const opener = useRef<HTMLButtonElement>(null);
  const navigationLocked = activeView === "settings" && settingsBusy;

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
          disabled={navigationLocked || actions === null || (unavailable && !focusableUncertain)}
          aria-disabled={focusableUncertain ? "true" : undefined}
          onClick={() => {
            if (focusableUncertain) return;
            setActiveView("chat");
            actions?.openNewConversation();
          }}
        >
          <Plus className={styles.plus} size={16} aria-hidden="true" />
          New chat
        </button>
      </div>
      <nav className={styles.nav} aria-label="Main navigation">
        {VIEWS.map((view) => {
          const active =
            view.id === "setup" ? onboardingOpen : view.id === activeView && !onboardingOpen;
          return (
            <button
              key={view.id}
              type="button"
              className={active ? `${styles.navItem} ${styles.on}` : styles.navItem}
              aria-current={active ? "page" : undefined}
              disabled={
                (navigationLocked && !onboardingOpen && view.id !== activeView) ||
                (view.id === "setup" && onboardingActions === null)
              }
              onClick={() => {
                if (view.id === "setup") {
                  void onboardingActions?.open();
                } else {
                  if (onboardingOpen) onboardingActions?.dismiss();
                  setActiveView(view.id);
                }
              }}
            >
              <view.icon className={styles.glyph} size={16} aria-hidden="true" />
              {view.label}
            </button>
          );
        })}
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
