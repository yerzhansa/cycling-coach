import type { ActivityExportFormat, WorkoutArchiveFormat } from "@enduragent/coach-contract";
import { useId, useState, type ReactElement } from "react";
import { Button } from "../../components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { useEnduragentStore } from "../../state/store";
import {
  trainingExportStatusCopy,
  type TrainingExportTarget,
} from "../../training-export/controller";
import { overviewStyles as styles } from "./overviewStyles";

const ACTIVITY_FORMATS = [
  { value: "fit", label: "FIT" },
  { value: "gpx", label: "GPX" },
] as const;

const WORKOUT_FORMATS = [
  { value: "zwo", label: "ZWO" },
  { value: "mrc", label: "MRC" },
  { value: "erg", label: "ERG" },
  { value: "fit", label: "FIT" },
] as const;

function Status(props: { readonly target: TrainingExportTarget }): ReactElement {
  const state = useEnduragentStore((store) => store.trainingExport);
  const copy =
    state.status === "idle" || state.target !== props.target ? "" : trainingExportStatusCopy(state);
  return (
    <p
      className={styles.exportStatus}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      hidden={copy.length === 0}
    >
      {copy}
    </p>
  );
}

export function ActivityExportControl(props: {
  readonly canonicalActivityId: string;
  readonly localDate: string;
}): ReactElement {
  const id = useId();
  const [format, setFormat] = useState<ActivityExportFormat>("fit");
  const state = useEnduragentStore((store) => store.trainingExport);
  const actions = useEnduragentStore((store) => store.trainingExportActions);
  const busy = state.status === "running";
  return (
    <section className={styles.analysisPanel} aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className={styles.analysisTitle}>
        Export ride
      </h2>
      <p className={styles.analysisIntro}>
        Save a copy to your computer. Exporting does not change this ride or your training account.
      </p>
      <div className={styles.exportControls}>
        <label htmlFor={`${id}-format`}>File format</label>
        <Select
          items={ACTIVITY_FORMATS}
          value={format}
          disabled={busy}
          onValueChange={(value) => {
            if (value !== null) setFormat(value as ActivityExportFormat);
          }}
        >
          <SelectTrigger id={`${id}-format`} className="min-w-[86px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="start">
            {ACTIVITY_FORMATS.map((entry) => (
              <SelectItem key={entry.value} value={entry.value}>
                {entry.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant="outline"
          disabled={actions === null || busy}
          aria-busy={busy ? "true" : undefined}
          onClick={() => {
            void actions?.exportActivity({ ...props, format });
          }}
        >
          Export ride
        </Button>
      </div>
      <Status target="activity" />
    </section>
  );
}

export function WorkoutArchiveExportControl(props: {
  readonly oldest: string;
  readonly newest: string;
}): ReactElement {
  const id = useId();
  const [format, setFormat] = useState<WorkoutArchiveFormat>("zwo");
  const state = useEnduragentStore((store) => store.trainingExport);
  const actions = useEnduragentStore((store) => store.trainingExportActions);
  const busy = state.status === "running";
  return (
    <div className={styles.planExport}>
      <p className={styles.support}>
        Save the visible planned workouts as a ZIP. Exporting does not change your plan.
      </p>
      <div className={styles.exportControls}>
        <label htmlFor={`${id}-format`}>Workout format</label>
        <Select
          items={WORKOUT_FORMATS}
          value={format}
          disabled={busy}
          onValueChange={(value) => {
            if (value !== null) setFormat(value as WorkoutArchiveFormat);
          }}
        >
          <SelectTrigger id={`${id}-format`} className="min-w-[86px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="start">
            {WORKOUT_FORMATS.map((entry) => (
              <SelectItem key={entry.value} value={entry.value}>
                {entry.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant="outline"
          disabled={actions === null || busy}
          aria-busy={busy ? "true" : undefined}
          onClick={() => {
            void actions?.exportWorkoutArchive({ ...props, format });
          }}
        >
          Export workouts
        </Button>
      </div>
      <Status target="workout-archive" />
    </div>
  );
}
