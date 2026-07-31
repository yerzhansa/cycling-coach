import { useEffect, useState, type ReactElement } from "react";
import { useEnduragentStore } from "../../state/store.js";
import styles from "./FirstSyncCard.module.css";

export function FirstSyncCard(): ReactElement | null {
  const state = useEnduragentStore((store) => store.firstSync);
  const actions = useEnduragentStore((store) => store.chatActions);
  const [retrying, setRetrying] = useState(false);
  const status = state.status;

  useEffect(() => {
    setRetrying(false);
  }, [status]);

  if (status === "idle" || status === "ready") return null;

  const syncing = status === "syncing";
  const unreachable = state.status === "failed" && state.kind === "protocol";

  return (
    <section
      className={`${styles.card} first-sync`}
      data-state={status}
      aria-labelledby="first-sync-title"
    >
      <div className={`${styles.mark} first-sync__mark`} aria-hidden="true" />
      <div className={`${styles.body} first-sync__body`}>
        <p className={`${styles.eyebrow} first-sync__eyebrow`}>Getting your coach ready</p>
        <h2 id="first-sync-title">
          {syncing
            ? "Syncing your training history…"
            : unreachable
              ? "Enduragent needs to reconnect safely"
              : "We couldn’t finish syncing"}
        </h2>
        <p className={`${styles.detail} first-sync__detail`}>
          {syncing
            ? "You can keep Enduragent open while rides, wellness, and calendar data are added."
            : unreachable
              ? "Quit and reopen Enduragent."
              : "Your saved progress is safe."}
        </p>
        {syncing ? (
          <div
            className={`${styles.track} first-sync__track`}
            role="progressbar"
            aria-label="Syncing training history"
          />
        ) : null}
        {!syncing && !unreachable ? (
          <button
            type="button"
            className={`${styles.retry} first-sync__retry`}
            disabled={retrying}
            onClick={() => {
              setRetrying(true);
              actions?.retryFirstSync();
            }}
          >
            Retry sync
          </button>
        ) : null}
      </div>
    </section>
  );
}
