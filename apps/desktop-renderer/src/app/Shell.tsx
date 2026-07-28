import { Suspense, useEffect, type ReactElement } from "react";
import { useEnduragentStore } from "../state/store.js";
import { ChatView } from "../ui/chat/ChatView.js";
import { Sidebar } from "../ui/sidebar/Sidebar.js";
import styles from "./Shell.module.css";
import { REACT_CHAT_REGION, VIEWS } from "./views.js";

export function Shell(props: { readonly onReady: () => void }): ReactElement {
  const activeView = useEnduragentStore((state) => state.activeView);
  const onReady = props.onReady;

  useEffect(() => {
    onReady();
  }, [onReady]);

  return (
    <div className={styles.win} data-view={activeView}>
      <Sidebar />
      <div className={styles.main}>
        <div className={styles.views}>
          <div className={activeView === "chat" ? styles.chatRegion : styles.away}>
            <ChatView />
          </div>
          {VIEWS.filter((view) => view.id === activeView && view.page !== REACT_CHAT_REGION).map(
            (view) => {
              const Page = view.page as Exclude<typeof view.page, typeof REACT_CHAT_REGION>;
              return (
                <Suspense
                  key={view.id}
                  fallback={<p className={styles.pending}>Loading {view.label.toLowerCase()}…</p>}
                >
                  <Page />
                </Suspense>
              );
            },
          )}
        </div>
      </div>
    </div>
  );
}
