import { useRef, type ReactElement } from "react";
import { setManualSyncFocusTarget } from "../../state/manual-sync-focus.js";
import { useEnduragentStore } from "../../state/store.js";
import type { TrainingContextViewState } from "../../training-context/controller.js";
import {
  sourceRestrictionSummary,
  STRAVA_RESTRICTION_DESKTOP_COPY,
  type ManualSyncViewState,
} from "../../training-context/manual-sync.js";
import { formatUtcTimestamp } from "../../training-context/format.js";
import { InfoTip } from "../onboarding/InfoTip.js";
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
  const setActiveView = useEnduragentStore((store) => store.setActiveView);
  const chip = useRef<HTMLButtonElement>(null);
  const status = syncChipStatus(training, sync);
  const synced = training.metadata?.lastSynced ?? null;
  const detail = status === "synced" && synced !== null ? formatUtcTimestamp(synced) : null;
  const restriction = sourceRestrictionSummary(sync.droppedActivities, "STRAVA");
  const restrictionLabel =
    restriction === null
      ? null
      : restriction.count === 1
        ? "1 hidden by Strava"
        : `${restriction.count} hidden by Strava`;

  return (
    <button
      type="button"
      ref={chip}
      className={`${styles.sync} sync-chip`}
      data-status={status}
      title={restriction === null || detail === null ? undefined : detail}
      disabled={sync.disabled || actions === null}
      aria-label={[sync.label, HEADLINE[status], restrictionLabel, detail]
        .filter(Boolean)
        .join(" · ")}
      onClick={(event) => {
        const keyboard = event.detail === 0;
        setManualSyncFocusTarget(keyboard ? chip.current : null);
        actions?.request(keyboard ? "keyboard" : "pointer");
      }}
    >
      <span className={styles.dot} data-status={status} aria-hidden="true" />
      <span className={styles.syncCopy}>
        <span className={styles.syncHeadline}>{HEADLINE[status]}</span>
        {restriction === null ? (
          detail === null ? null : (
            <span className={styles.syncWhen}>{detail}</span>
          )
        ) : (
          <span className="mt-px flex min-w-0 items-center gap-1 font-mono text-[11px] text-warn">
            <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
              {restrictionLabel}
            </span>
            <InfoTip
              label="Why are activities hidden?"
              lead={STRAVA_RESTRICTION_DESKTOP_COPY.tooltipLead(restriction.count)}
              trigger={
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(event) => {
                    event.stopPropagation();
                  }}
                />
              }
              body={
                <>
                  {STRAVA_RESTRICTION_DESKTOP_COPY.tooltipBody}{" "}
                  <a
                    href="#strava-restricted-activities"
                    className="text-brand underline-offset-2 hover:underline"
                    onPointerDown={() => {
                      setActiveView("training");
                    }}
                    onClick={() => {
                      setActiveView("training");
                    }}
                  >
                    How to fix this
                  </a>
                </>
              }
            />
          </span>
        )}
      </span>
      <span className={styles.syncAction} aria-hidden="true">
        {sync.label}
      </span>
    </button>
  );
}
