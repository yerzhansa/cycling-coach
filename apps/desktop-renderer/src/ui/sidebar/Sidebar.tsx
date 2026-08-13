import { Plus } from "lucide-react";
import { useEffect, useRef, type ReactElement } from "react";
import { VIEWS } from "../../app/views.js";
import { registerNewConversationOpener } from "../../state/new-conversation-opener.js";
import { settingsMutationActive } from "../../state/settings-slice.js";
import { setupStatusKnown } from "../../onboarding/controller.js";
import { SETUP_STATUS_CHECKING_COPY } from "../onboarding/copy.js";
import { setupReady } from "../../state/onboarding-slice.js";
import { useEnduragentStore } from "../../state/store.js";
import styles from "./Sidebar.module.css";
import { SyncChip } from "./SyncChip.js";
import { UpdateAvailableButton } from "./UpdateAvailableButton.js";

export function Sidebar(): ReactElement {
  const activeView = useEnduragentStore((state) => state.activeView);
  const setActiveView = useEnduragentStore((state) => state.setActiveView);
  const unavailable = useEnduragentStore((state) => state.chat.newConversationUnavailable);
  const resetPhase = useEnduragentStore((state) => state.chat.resetPhase);
  const actions = useEnduragentStore((state) => state.chatActions);
  const canChat = useEnduragentStore(setupReady);
  const statusKnown = useEnduragentStore((state) => setupStatusKnown(state.onboarding));
  const setupState = canChat ? "ready" : statusKnown ? "waiting" : "checking";
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
          disabled={
            !canChat || navigationLocked || actions === null || (unavailable && !focusableUncertain)
          }
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
          const active = view.id === activeView;
          return (
            <button
              key={view.id}
              type="button"
              className={active ? `${styles.navItem} ${styles.on}` : styles.navItem}
              aria-current={active ? "page" : undefined}
              disabled={navigationLocked && view.id !== activeView}
              onClick={() => {
                setActiveView(view.id);
              }}
            >
              <view.icon className={styles.glyph} size={16} aria-hidden="true" />
              {view.label}
            </button>
          );
        })}
      </nav>
      <div className={styles.railFoot}>
        <UpdateAvailableButton locked={navigationLocked} />
        <SyncChip />
        <div
          className="flex min-h-ctl items-center gap-2 px-row text-xs text-ink-2"
          data-sidebar-setup-readiness={setupState}
        >
          <span
            className={`size-2 rounded-full ${setupState === "ready" ? "bg-ok" : setupState === "waiting" ? "bg-warn" : "bg-line-2"}`}
            data-sidebar-setup-dot={setupState}
            aria-hidden="true"
          />
          <span>
            {setupState === "ready"
              ? "Ready"
              : setupState === "waiting"
                ? "Waiting for setup"
                : SETUP_STATUS_CHECKING_COPY}
          </span>
        </div>
      </div>
    </aside>
  );
}
