import { Suspense, useEffect, type ReactElement } from "react";
import { setupDisposition } from "../state/onboarding-slice.js";
import { useEnduragentStore } from "../state/store.js";
import { ChatView } from "../ui/chat/ChatView.js";
import { Sidebar } from "../ui/sidebar/Sidebar.js";
import { SetupGate } from "./SetupGate.js";
import { REACT_CHAT_REGION, VIEWS } from "./views.js";

export function Shell(props: { readonly onReady: () => void }): ReactElement {
  const activeView = useEnduragentStore((state) => state.activeView);
  const disposition = useEnduragentStore(setupDisposition);
  const onboardingStartupSettled = useEnduragentStore((state) => state.onboardingStartupSettled);
  const onReady = props.onReady;
  const onboardingState = onboardingStartupSettled ? "settled" : "pending";

  useEffect(() => {
    onReady();
  }, [onReady]);

  return (
    <div
      className={`fixed inset-0 grid bg-bg bg-repeat text-[14px] leading-[1.5] font-sans text-ink [background-image:var(--grain)] [background-size:256px_256px] ${
        disposition === "satisfied"
          ? "grid-cols-[260px_minmax(0,1fr)] max-[1100px]:grid-cols-[208px_minmax(0,1fr)] max-[860px]:grid-cols-[184px_minmax(0,1fr)]"
          : "grid-cols-[minmax(0,1fr)]"
      }`}
      data-view={activeView}
      data-onboarding={onboardingState}
      data-shell={
        disposition === "unknown" ? "unknown" : disposition === "required" ? "gate" : "app"
      }
    >
      {disposition === "unknown" ? (
        <div
          className="col-span-full flex items-center justify-center text-sm text-ink-2"
          role="status"
          aria-live="polite"
          aria-busy="true"
        >
          Checking setup…
        </div>
      ) : disposition === "required" ? (
        <SetupGate />
      ) : (
        <>
          <Sidebar />
          <div className="flex min-h-0 min-w-0 flex-col">
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              <div
                className={
                  activeView === "chat"
                    ? "grid min-h-0 min-w-0 flex-1 grid-cols-[minmax(0,1fr)] grid-rows-[0_minmax(0,1fr)] [&>.conversation]:row-start-2"
                    : "hidden"
                }
              >
                <ChatView />
              </div>
              {VIEWS.filter(
                (view) => view.id === activeView && view.page !== REACT_CHAT_REGION,
              ).map((view) => {
                const Page = view.page as Exclude<typeof view.page, typeof REACT_CHAT_REGION>;
                return (
                  <Suspense
                    key={view.id}
                    fallback={
                      <p className="px-8 py-7 text-ink-3">Loading {view.label.toLowerCase()}…</p>
                    }
                  >
                    <Page />
                  </Suspense>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
