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
import {
  focusTrainingRestrictionIfPresent,
  requestTrainingRestrictionFocus,
  STRAVA_RESTRICTION_CARD_ID,
} from "../training/restriction-focus.js";
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
  const closeRide = useEnduragentStore((store) => store.closeRide);
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
    <div className={`${styles.sync} relative`} data-sync-chip="" data-status={status}>
      <button
        type="button"
        ref={chip}
        className="sync-chip absolute inset-0 z-0 m-0 appearance-none rounded-ctl border-0 bg-transparent p-0 disabled:cursor-default"
        data-status={status}
        title={restriction === null || detail === null ? undefined : detail}
        disabled={sync.disabled || actions === null}
        aria-label={[sync.label, HEADLINE[status], detail].filter(Boolean).join(" · ")}
        onClick={(event) => {
          const keyboard = event.detail === 0;
          setManualSyncFocusTarget(keyboard ? chip.current : null);
          actions?.request(keyboard ? "keyboard" : "pointer");
        }}
      />
      <span
        className={`${styles.dot} pointer-events-none relative z-[1]`}
        data-status={status}
        aria-hidden="true"
      />
      <span className={`${styles.syncCopy} pointer-events-none relative z-[1]`}>
        <span className={styles.syncHeadline} aria-hidden="true">
          {HEADLINE[status]}
        </span>
        {restriction === null ? (
          detail === null ? null : (
            <span className={styles.syncWhen} aria-hidden="true">
              {detail}
            </span>
          )
        ) : (
          <InfoTip
            label="Why are activities hidden?"
            lead={STRAVA_RESTRICTION_DESKTOP_COPY.tooltipLead(restriction.count)}
            trigger={
              <a
                href={`#${STRAVA_RESTRICTION_CARD_ID}`}
                aria-label={`${restrictionLabel}. How to fix this`}
                className="pointer-events-auto mt-px flex w-full min-w-0 items-center gap-1 font-mono text-[11px] no-underline"
                onClick={(event) => {
                  setActiveView("training");
                  if (useEnduragentStore.getState().activeView !== "training") {
                    event.preventDefault();
                    return;
                  }
                  requestTrainingRestrictionFocus();
                  closeRide();
                  focusTrainingRestrictionIfPresent(
                    document.getElementById(STRAVA_RESTRICTION_CARD_ID),
                  );
                }}
              />
            }
            triggerContent={
              <>
                <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-warn">
                  {restrictionLabel}
                </span>
                <span className="flex-none font-sans text-brand underline-offset-2 hover:underline">
                  · How to fix this
                </span>
              </>
            }
            body={STRAVA_RESTRICTION_DESKTOP_COPY.tooltipBody}
          />
        )}
      </span>
      <span
        className={`${styles.syncAction} pointer-events-none relative z-[1]`}
        aria-hidden="true"
      >
        {sync.label}
      </span>
    </div>
  );
}
