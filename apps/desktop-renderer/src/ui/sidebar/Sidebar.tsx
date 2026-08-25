import { Plus } from "lucide-react";
import { useEffect, useRef, type ReactElement } from "react";
import { Button } from "../../components/ui/button.js";
import { cn } from "../../lib/utils.js";
import { VIEWS } from "../../app/views.js";
import { registerNewConversationOpener } from "../../state/new-conversation-opener.js";
import { settingsMutationActive } from "../../state/settings-slice.js";
import { setupReady } from "../../state/onboarding-slice.js";
import { useEnduragentStore } from "../../state/store.js";
import { SyncChip } from "./SyncChip.js";
import { UpdateAvailableButton } from "./UpdateAvailableButton.js";

export function Sidebar(): ReactElement {
  const activeView = useEnduragentStore((state) => state.activeView);
  const setActiveView = useEnduragentStore((state) => state.setActiveView);
  const unavailable = useEnduragentStore((state) => state.chat.newConversationUnavailable);
  const resetPhase = useEnduragentStore((state) => state.chat.resetPhase);
  const actions = useEnduragentStore((state) => state.chatActions);
  const canChat = useEnduragentStore(setupReady);
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
    <aside className="flex min-h-0 flex-col border-r border-line bg-rail">
      <div className="px-inset pt-3.5">
        <div className="px-row pb-3.5 text-sm font-semibold tracking-normal">Enduragent</div>
        <Button
          type="button"
          ref={opener}
          variant="outline"
          size="default"
          className="new-conversation-button w-full justify-start gap-2 bg-surface text-ink hover:bg-surface-2"
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
          <Plus className="text-ink-2" size={16} aria-hidden="true" />
          New chat
        </Button>
      </div>
      <nav className="flex flex-col gap-0.5 px-inset pt-3" aria-label="Main navigation">
        {VIEWS.map((view) => {
          const active = view.id === activeView;
          return (
            <Button
              key={view.id}
              type="button"
              variant="ghost"
              size="default"
              className={cn(
                "w-full justify-start gap-2 px-row text-ink-2 hover:text-ink",
                active && "bg-surface font-medium text-ink hover:bg-surface",
              )}
              aria-current={active ? "page" : undefined}
              disabled={navigationLocked && view.id !== activeView}
              onClick={() => {
                setActiveView(view.id);
              }}
            >
              <view.icon
                className="text-ink-3 group-hover/button:text-ink-2"
                size={16}
                aria-hidden="true"
              />
              {view.label}
            </Button>
          );
        })}
      </nav>
      <div className="mt-auto grid gap-0.5 border-t border-line p-inset">
        <UpdateAvailableButton locked={navigationLocked} />
        <SyncChip />
      </div>
    </aside>
  );
}
