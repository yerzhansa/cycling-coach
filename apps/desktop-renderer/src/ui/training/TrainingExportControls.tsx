import type { ActivityExportFormat, WorkoutArchiveFormat } from "@enduragent/coach-contract";
import { useId, useState, type ReactElement } from "react";
import { useEnduragentStore } from "../../state/store.js";
import {
  trainingExportStatusCopy,
  type TrainingExportTarget,
} from "../../training-export/controller.js";
import styles from "./TrainingView.module.css";

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
        <select
          id={`${id}-format`}
          className={styles.exportSelect}
          value={format}
          disabled={busy}
          onChange={(event) => setFormat(event.currentTarget.value as ActivityExportFormat)}
        >
          <option value="fit">FIT</option>
          <option value="gpx">GPX</option>
        </select>
        <button
          type="button"
          className={styles.action}
          disabled={actions === null || busy}
          aria-busy={busy ? "true" : undefined}
          onClick={() => {
            void actions?.exportActivity({ ...props, format });
          }}
        >
          Export ride
        </button>
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
        <select
          id={`${id}-format`}
          className={styles.exportSelect}
          value={format}
          disabled={busy}
          onChange={(event) => setFormat(event.currentTarget.value as WorkoutArchiveFormat)}
        >
          <option value="zwo">ZWO</option>
          <option value="mrc">MRC</option>
          <option value="erg">ERG</option>
          <option value="fit">FIT</option>
        </select>
        <button
          type="button"
          className={styles.action}
          disabled={actions === null || busy}
          aria-busy={busy ? "true" : undefined}
          onClick={() => {
            void actions?.exportWorkoutArchive({ ...props, format });
          }}
        >
          Export workouts
        </button>
      </div>
      <Status target="workout-archive" />
    </div>
  );
}
