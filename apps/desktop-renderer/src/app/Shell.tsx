import { Suspense, useEffect, useRef, type ReactElement } from "react";
import type { LegacyHosts } from "../legacy-boot.js";
import { useEnduragentStore } from "../state/store.js";
import { ChatView } from "../ui/chat/ChatView.js";
import { Sidebar } from "../ui/sidebar/Sidebar.js";
import styles from "./Shell.module.css";
import { REACT_CHAT_REGION, VIEWS } from "./views.js";

export function Shell(props: {
  readonly onHostsReady: (hosts: LegacyHosts) => void;
}): ReactElement {
  const activeView = useEnduragentStore((state) => state.activeView);
  const topbar = useRef<HTMLElement>(null);
  const spine = useRef<HTMLElement>(null);
  const drawer = useRef<HTMLDialogElement>(null);
  const onHostsReady = props.onHostsReady;

  useEffect(() => {
    const hosts = {
      topbar: topbar.current,
      spine: spine.current,
      drawer: drawer.current,
    };
    if (Object.values(hosts).some((host) => host === null)) return;
    onHostsReady(hosts as LegacyHosts);
  }, [onHostsReady]);

  return (
    <div className={styles.win}>
      <Sidebar />
      <div className={styles.main}>
        <header className={`topbar ${styles.strip}`} ref={topbar} />
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
        <div className={styles.spineHost}>
          <aside className="data-spine" aria-label="Training data drawer" ref={spine} />
          <dialog className="drawer" aria-label="Training data" ref={drawer} />
        </div>
      </div>
    </div>
  );
}
