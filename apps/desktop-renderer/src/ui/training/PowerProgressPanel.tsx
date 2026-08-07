import type { PowerProgressComputed, PowerProgressPanel } from "@enduragent/coach-contract";
import type { ReactElement } from "react";
import {
  formatDateLabel,
  formatUtcTimestamp,
  formatWholeNumber,
} from "../../training-context/format.js";
import {
  POWER_PROGRESS_FRESHNESS_COPY,
  POWER_PROGRESS_REFRESH_FAILURE_COPY,
  POWER_PROGRESS_ROTATION_COPY,
  POWER_PROGRESS_UNAVAILABLE_COPY,
} from "./copy.js";
import styles from "./TrainingView.module.css";

const POWER_DURATION_LABELS = new Map<number, string>([
  [5, "5 sec"],
  [60, "1 min"],
  [300, "5 min"],
  [1_200, "20 min"],
  [3_600, "60 min"],
]);

function formatPowerDuration(durationSeconds: number): string {
  return POWER_DURATION_LABELS.get(durationSeconds) ?? `${durationSeconds} sec`;
}

function formatProgressChange(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  const normalized = Object.is(rounded, -0) ? 0 : rounded;
  return `${normalized > 0 ? "+" : ""}${normalized}%`;
}

function formatProgressMagnitude(value: number): string {
  return `${Math.round(Math.abs(value) * 10) / 10}%`;
}

function ProgressWatts(props: {
  readonly value:
    | { readonly kind: "computed"; readonly watts: number }
    | { readonly kind: "unavailable" };
}): ReactElement {
  return props.value.kind === "computed" ? (
    <span>{formatWholeNumber(props.value.watts)} W</span>
  ) : (
    <span aria-label="Unavailable">—</span>
  );
}

function ProgressBpm(props: {
  readonly value:
    | { readonly kind: "computed"; readonly bpm: number }
    | { readonly kind: "unavailable" };
}): ReactElement {
  return props.value.kind === "computed" ? (
    <span>{formatWholeNumber(props.value.bpm)} bpm</span>
  ) : (
    <span aria-label="Unavailable">—</span>
  );
}

function ProgressChange(props: {
  readonly value:
    | { readonly kind: "computed"; readonly percent: number }
    | { readonly kind: "unavailable" };
}): ReactElement {
  if (props.value.kind === "unavailable") return <span aria-label="Unavailable">—</span>;
  const { percent } = props.value;
  const direction = percent > 0 ? "Increased" : percent < 0 ? "Decreased" : "No change";
  const arrow = percent > 0 ? "↑" : percent < 0 ? "↓" : "→";
  const tone = percent > 0 ? "positive" : percent < 0 ? "negative" : "neutral";
  return (
    <span
      className={styles.progressChange}
      data-tone={tone}
      aria-label={`${direction}, ${formatProgressMagnitude(percent)}`}
    >
      <span aria-hidden="true">{arrow}</span> {formatProgressChange(percent)}
    </span>
  );
}

function PowerProgressTable(props: { readonly progress: PowerProgressComputed }): ReactElement {
  return (
    <div className={styles.progressTableWrap}>
      <table className={styles.progressTable}>
        <caption className={styles.srOnly}>
          Power curve for the current 28 days compared with the previous 28 days
        </caption>
        <thead>
          <tr>
            <th scope="col">Effort</th>
            <th scope="col">Now</th>
            <th scope="col">Prior</th>
            <th scope="col">Change</th>
          </tr>
        </thead>
        <tbody>
          {props.progress.anchors.map((anchor) => (
            <tr key={anchor.durationSeconds}>
              <th scope="row">{formatPowerDuration(anchor.durationSeconds)}</th>
              <td>
                <ProgressWatts value={anchor.current} />
              </td>
              <td>
                <ProgressWatts value={anchor.previous} />
              </td>
              <td>
                <ProgressChange value={anchor.change} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HeartRateProgress(props: { readonly progress: PowerProgressComputed }): ReactElement {
  if (props.progress.heartRateContext.kind === "unavailable") {
    return <p className={styles.support}>Heart-rate comparison needs more data.</p>;
  }
  return (
    <details className={styles.progressDetails}>
      <summary>
        Heart-rate response · {props.progress.heartRateContext.anchors.length} efforts
      </summary>
      <div className={styles.progressTableWrap}>
        <table className={`${styles.progressTable} ${styles.heartRateTable}`}>
          <caption className={styles.srOnly}>
            Heart-rate curve for the current 28 days compared with the previous 28 days
          </caption>
          <thead>
            <tr>
              <th scope="col">Effort</th>
              <th scope="col">Now</th>
              <th scope="col">Prior</th>
              <th scope="col">Change</th>
            </tr>
          </thead>
          <tbody>
            {props.progress.heartRateContext.anchors.map((anchor) => (
              <tr key={anchor.durationSeconds}>
                <th scope="row">{formatPowerDuration(anchor.durationSeconds)}</th>
                <td>
                  <ProgressBpm value={anchor.current} />
                </td>
                <td>
                  <ProgressBpm value={anchor.previous} />
                </td>
                <td>
                  <ProgressChange value={anchor.change} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function sustainabilityCopy(progress: PowerProgressComputed): string {
  if (progress.sustainabilityContext.kind === "unavailable") {
    return "Durability context needs more data.";
  }
  const source = {
    indoor: "indoor rides",
    outdoor: "outdoor rides",
    mixed: "indoor and outdoor rides",
    unknown: "available rides",
  }[progress.sustainabilityContext.sourceContext];
  return `42-day durability context · ${Math.round(progress.sustainabilityContext.coverageRatio * 100)}% curve coverage · ${source}`;
}

export function PowerProgressContent(props: { readonly panel: PowerProgressPanel }): ReactElement {
  if (props.panel.kind === "unavailable") {
    return <p className={styles.empty}>{POWER_PROGRESS_UNAVAILABLE_COPY[props.panel.reason]}</p>;
  }
  const progress = props.panel.kind === "stale" ? props.panel.lastGood : props.panel;
  return (
    <>
      {props.panel.kind === "stale" ? (
        <p className={styles.progressNotice}>
          {POWER_PROGRESS_REFRESH_FAILURE_COPY[props.panel.refreshFailure.code]} Showing the last
          complete comparison. Failed{" "}
          <time dateTime={props.panel.refreshFailure.failedAt}>
            {formatUtcTimestamp(props.panel.refreshFailure.failedAt)}
          </time>
          .
        </p>
      ) : null}
      <div className={styles.progressHeader}>
        <div>
          <p className={styles.progressLead}>{POWER_PROGRESS_ROTATION_COPY[progress.rotation]}</p>
          <p className={styles.meta}>
            {formatDateLabel(progress.currentWindow.start)}–
            {formatDateLabel(progress.currentWindow.end)} · compared with the prior 28 days
          </p>
        </div>
        <p className={styles.badge} data-freshness={progress.freshness}>
          {POWER_PROGRESS_FRESHNESS_COPY[progress.freshness]}
        </p>
      </div>
      <PowerProgressTable progress={progress} />
      <HeartRateProgress progress={progress} />
      <p className={styles.progressFoot}>{sustainabilityCopy(progress)}</p>
    </>
  );
}
