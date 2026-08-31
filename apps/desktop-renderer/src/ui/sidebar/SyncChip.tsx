import { useRef, type ReactElement } from "react";
import { Button } from "../../components/ui/button";
import { cn } from "../../lib/utils";
import { setManualSyncFocusTarget } from "../../state/manual-sync-focus";
import { useEnduragentStore } from "../../state/store";
import type { TrainingContextViewState } from "../../training-context/controller";
import {
  sourceRestrictionSummary,
  STRAVA_RESTRICTION_DESKTOP_COPY,
  type ManualSyncViewState,
} from "../../training-context/manual-sync";
import { formatUtcTimestamp } from "../../training-context/format";
import { InfoTip } from "../onboarding/InfoTip";
import {
  focusTrainingRestrictionIfPresent,
  requestTrainingRestrictionFocus,
  STRAVA_RESTRICTION_CARD_ID,
} from "../training/restriction-focus";

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
    <div
      className="relative flex min-h-ctl min-w-0 w-full items-center gap-2 px-row py-1.5 text-left text-xs font-normal text-ink-2"
      data-sync-chip=""
      data-status={status}
    >
      <Button
        type="button"
        ref={chip}
        variant="ghost"
        size="default"
        className="sync-chip absolute inset-0 z-0 h-auto w-full p-0"
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
        className={cn(
          "pointer-events-none relative z-[1] size-[7px] flex-none rounded-full bg-ink-3",
          status === "synced" && "bg-ok",
          status === "syncing" && "bg-ink-2",
          (status === "attention" || status === "unavailable") && "bg-warn",
        )}
        data-status={status}
        aria-hidden="true"
      />
      <span className="pointer-events-none relative z-[1] min-w-0 flex-1">
        <span className="block truncate" aria-hidden="true">
          {HEADLINE[status]}
        </span>
        {restriction === null ? (
          detail === null ? null : (
            <span className="mt-px block truncate text-ink-3" aria-hidden="true">
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
                className="pointer-events-auto mt-px flex w-full min-w-0 items-center gap-1 text-[11px] no-underline"
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
        className="pointer-events-none relative z-[1] flex-none text-xs text-ink-3 max-[860px]:hidden"
        aria-hidden="true"
      >
        {sync.label}
      </span>
    </div>
  );
}
