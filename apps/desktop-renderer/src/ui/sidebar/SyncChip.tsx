import { useRef, type ReactElement } from "react";
import { setManualSyncFocusTarget } from "../../state/manual-sync-focus.js";
import { useEnduragentStore } from "../../state/store.js";
import type { TrainingContextViewState } from "../../training-context/controller.js";
import type { ManualSyncViewState } from "../../training-context/manual-sync.js";
import { formatUtcTimestamp } from "../../training-context/format.js";
import styles from "./Sidebar.module.css";

type SyncChipStatus = "loading" | "syncing" | "attention" | "synced" | "never" | "unavailable";

function syncChipStatus(
  training: TrainingContextViewState,
  sync: ManualSyncViewState,
): SyncChipStatus {
  if (sync.busy) return "syncing";
  if (sync.tone === "failure" || sync.tone === "partial") return "attention";
  if (training.status === "loading") return "loading";
  if (training.metadata !== null && training.metadata.lastSynced !== null) return "synced";
  return training.status === "unavailable" ? "unavailable" : "never";
}

const HEADLINE: Readonly<Record<SyncChipStatus, string>> = {
  loading: "Loading training data",
  syncing: "Syncing",
  attention: "Sync needs attention",
  synced: "Training data synced",
  never: "Not synced yet",
  unavailable: "Training data unavailable",
};

export function SyncChip(): ReactElement {
  const training = useEnduragentStore((store) => store.training);
  const sync = useEnduragentStore((store) => store.sync);
  const actions = useEnduragentStore((store) => store.syncActions);
  const chip = useRef<HTMLButtonElement>(null);
  const status = syncChipStatus(training, sync);
  const synced = training.metadata?.lastSynced ?? null;
  const detail = status === "synced" && synced !== null ? formatUtcTimestamp(synced) : null;

  return (
    <button
      type="button"
      ref={chip}
      className={`${styles.sync} sync-chip`}
      data-status={status}
      disabled={sync.disabled || actions === null}
      aria-label={`${sync.label} · ${HEADLINE[status]}`}
      onClick={(event) => {
        const keyboard = event.detail === 0;
        setManualSyncFocusTarget(keyboard ? chip.current : null);
        actions?.request(keyboard ? "keyboard" : "pointer");
      }}
    >
      <span className={styles.dot} data-status={status} aria-hidden="true" />
      <span className={styles.syncCopy}>
        <span className={styles.syncHeadline}>{HEADLINE[status]}</span>
        {detail === null ? null : <span className={styles.syncWhen}>{detail}</span>}
      </span>
      <span className={styles.syncAction} aria-hidden="true">
        {sync.label}
      </span>
    </button>
  );
}
