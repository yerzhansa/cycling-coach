import { useRef, type ReactElement } from "react";
import { Button } from "../../components/ui/button.js";
import { cn } from "../../lib/utils.js";
import { setManualSyncFocusTarget } from "../../state/manual-sync-focus.js";
import { useEnduragentStore } from "../../state/store.js";
import type { TrainingContextViewState } from "../../training-context/controller.js";
import type { ManualSyncViewState } from "../../training-context/manual-sync.js";
import { formatUtcTimestamp } from "../../training-context/format.js";

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
    <Button
      type="button"
      ref={chip}
      variant="ghost"
      size="default"
      className="sync-chip h-auto min-h-ctl w-full justify-start gap-2 px-row py-1.5 text-left text-xs font-normal whitespace-normal text-ink-2"
      data-status={status}
      disabled={sync.disabled || actions === null}
      aria-label={[sync.label, HEADLINE[status], detail].filter(Boolean).join(" · ")}
      onClick={(event) => {
        const keyboard = event.detail === 0;
        setManualSyncFocusTarget(keyboard ? chip.current : null);
        actions?.request(keyboard ? "keyboard" : "pointer");
      }}
    >
      <span
        className={cn(
          "size-[7px] flex-none rounded-full bg-ink-3",
          status === "synced" && "bg-ok",
          status === "syncing" && "bg-ink-2",
          (status === "attention" || status === "unavailable") && "bg-warn",
        )}
        data-status={status}
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate">{HEADLINE[status]}</span>
        {detail === null ? null : <span className="mt-px block truncate text-ink-3">{detail}</span>}
      </span>
      <span className="flex-none text-xs text-ink-3" aria-hidden="true">
        {sync.label}
      </span>
    </Button>
  );
}
