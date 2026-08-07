import type {
  ActivityAnalysisData,
  AnalysisSection,
  RecentRide,
  RecentRidesPanel,
  UnitsPreference,
} from "@enduragent/coach-contract";
import type { ReactElement, Ref } from "react";
import type { RideAnalysisViewState } from "../../activity-analysis/controller.js";
import { formatDateLabel } from "../../training-context/format.js";
import { Page } from "../shared/Page.js";
import { analysisRefreshFailureCopy, analysisUnavailableCopy } from "./copy.js";
import styles from "./TrainingView.module.css";

const RIDE_KIND: Readonly<Record<string, string>> = {
  road: "Road ride",
  mountain: "Mountain bike ride",
  downhill: "Downhill ride",
  cyclocross: "Cyclocross ride",
  track: "Track ride",
  indoor_cycling: "Indoor ride",
  virtual_activity: "Virtual ride",
  gravel_cycling: "Gravel ride",
};

const EMPTY_COPY: Readonly<
  Record<Extract<RecentRidesPanel, { kind: "unknown" }>["reason"], string>
> = {
  "not-synced": "Sync or import a cycling ride to review it here.",
  "no-recent-rides": "No cycling rides are available from the last 28 days.",
  "temporary-failure": "Recent rides could not be refreshed. Try syncing again.",
};

function rideKind(ride: RecentRide): string {
  return ride.subSport === null || ride.subSport === "generic"
    ? "Cycling ride"
    : (RIDE_KIND[ride.subSport] ?? "Cycling ride");
}

function rideDuration(ride: RecentRide): string {
  const seconds = ride.elapsedSeconds ?? ride.movingSeconds;
  if (seconds === null) return "Duration unavailable";
  const roundedMinutes = Math.round(seconds / 60);
  const hours = Math.floor(roundedMinutes / 60);
  const minutes = roundedMinutes % 60;
  return hours === 0 ? `${minutes}m` : `${hours}h ${minutes}m`;
}

function rideDistance(ride: RecentRide, units: UnitsPreference): string {
  if (ride.distanceMeters === null) return "Distance unavailable";
  if (units === "imperial") return `${(ride.distanceMeters / 1_609.344).toFixed(1)} mi`;
  return `${(ride.distanceMeters / 1_000).toFixed(1)} km`;
}

function rideTime(ride: RecentRide): string | null {
  if (ride.timezoneOffsetSeconds === null) return null;
  const milliseconds = (ride.startEpochSeconds + ride.timezoneOffsetSeconds) * 1_000;
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(11, 16) : null;
}

function rideDateTime(ride: RecentRide): string {
  const time = rideTime(ride);
  return time === null
    ? formatDateLabel(ride.localDate)
    : `${formatDateLabel(ride.localDate)} · ${time}`;
}

function RideSummary(props: {
  readonly ride: RecentRide;
  readonly units: UnitsPreference;
}): ReactElement {
  return (
    <dl className={styles.rideSummary}>
      <div>
        <dt>Date</dt>
        <dd>
          <time dateTime={props.ride.localDate}>{rideDateTime(props.ride)}</time>
        </dd>
      </div>
      <div>
        <dt>Duration</dt>
        <dd>{rideDuration(props.ride)}</dd>
      </div>
      <div>
        <dt>Distance</dt>
        <dd>{rideDistance(props.ride, props.units)}</dd>
      </div>
    </dl>
  );
}

function formatAnalysisDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return hours === 0 ? `${minutes} min` : `${hours} hr ${remainder} min`;
}

function formatDrift(value: number): string {
  const rounded = Math.abs(value) < 0.05 ? 0 : value;
  return `${rounded > 0 ? "+" : ""}${rounded.toFixed(1)}%`;
}

const LIMITATION_COPY: Readonly<
  Record<ActivityAnalysisData["aerobicDrift"]["limitations"][number], string>
> = {
  "duration-under-60-minutes": "Usable duration is below the 60-minute reference context.",
  "variable-output": "Power varied substantially across the ride.",
  "moving-status-unavailable":
    "No moving-status stream was available, so stopped time may be included.",
};

function shouldOfferRetry(reason: Parameters<typeof analysisUnavailableCopy>[0]): boolean {
  return (
    reason === "empty-response" ||
    reason === "malformed-response" ||
    reason === "response-too-large" ||
    reason === "request-budget-exhausted" ||
    reason === "rate-limited" ||
    reason === "timeout" ||
    reason === "network" ||
    reason === "provider-unavailable" ||
    reason === "cancelled" ||
    reason === "temporary-failure"
  );
}

function DriftHalf(props: {
  readonly label: string;
  readonly half: ActivityAnalysisData["aerobicDrift"]["firstHalf"];
}): ReactElement {
  return (
    <div className={styles.driftHalf}>
      <h3>{props.label}</h3>
      <p className={styles.driftEf}>{props.half.efficiencyFactor.toFixed(2)} EF</p>
      <p className={styles.driftHalfStats}>
        {Math.round(props.half.averagePowerWatts)} W · {Math.round(props.half.averageHeartRateBpm)}{" "}
        bpm
      </p>
      <p className={styles.driftHalfMeta}>
        {formatAnalysisDuration(props.half.durationSeconds)} ·{" "}
        {props.half.sampleCount.toLocaleString()} samples
      </p>
    </div>
  );
}

function DriftEvidence(props: {
  readonly data: ActivityAnalysisData["aerobicDrift"];
  readonly saved: boolean;
  readonly refreshing?: boolean;
  readonly clientRefreshUnavailable?: boolean;
  readonly refreshFailure?: Extract<
    AnalysisSection<ActivityAnalysisData["aerobicDrift"]>,
    { readonly kind: "stale" }
  >["refreshFailure"];
}): ReactElement {
  const provenance = props.saved ? "Saved analysis" : "Current analysis";
  const notice =
    props.refreshFailure !== undefined
      ? `Showing the saved result. ${analysisRefreshFailureCopy(props.refreshFailure.code)}`
      : props.clientRefreshUnavailable === true
        ? "Showing the previous result. The latest refresh did not finish."
        : props.refreshing === true
          ? "Refreshing the ride analysis…"
          : null;
  return (
    <>
      {notice === null ? null : (
        <p
          className={props.refreshing === true ? styles.analysisRefresh : styles.analysisNotice}
          role="status"
        >
          {notice}
        </p>
      )}
      <div className={styles.driftReading}>
        <div>
          <p className={styles.rideEyebrow}>Observed EF change</p>
          <p
            className={styles.driftValue}
            aria-label={`Observed efficiency-factor change ${formatDrift(props.data.decouplingPercent)}`}
          >
            {formatDrift(props.data.decouplingPercent)}
          </p>
        </div>
        <div className={styles.driftContext}>
          <span className={styles.driftEvidenceBadge} data-evidence={props.data.evidence}>
            {props.data.evidence === "standard" ? "Data checks passed" : "Limited context"}
          </span>
          <p>{provenance} · whole ride</p>
        </div>
      </div>
      <div className={styles.driftTrace}>
        <DriftHalf label="First half" half={props.data.firstHalf} />
        <span className={styles.driftConnector} aria-hidden="true">
          →
        </span>
        <DriftHalf label="Second half" half={props.data.secondHalf} />
      </div>
      <p className={styles.driftCoverage}>
        {Math.round(props.data.coverage.fraction * 100)}% usable time ·{" "}
        {formatAnalysisDuration(props.data.coverage.includedDurationSeconds)} included ·{" "}
        {props.data.coverage.validSamples.toLocaleString()} of{" "}
        {props.data.coverage.totalSamples.toLocaleString()} samples
      </p>
      {props.data.limitations.length === 0 ? null : (
        <ul className={styles.driftLimitations} aria-label="Analysis limitations">
          {props.data.limitations.map((limitation) => (
            <li key={limitation}>{LIMITATION_COPY[limitation]}</li>
          ))}
        </ul>
      )}
    </>
  );
}

function AerobicDriftPanel(props: {
  readonly rideId: string;
  readonly analysis: RideAnalysisViewState;
  readonly onRefresh: (() => void) | null;
}): ReactElement {
  const matches = props.analysis.activityId === props.rideId;
  const section = matches ? props.analysis.sections.aerobicDrift : undefined;
  let content: ReactElement;
  if (section?.kind === "computed") {
    content = (
      <DriftEvidence
        data={section.data}
        saved={section.provenance.delivery === "persisted-cache"}
        refreshing={props.analysis.status === "loading"}
        clientRefreshUnavailable={props.analysis.status === "refresh-unavailable"}
      />
    );
  } else if (section?.kind === "stale") {
    content = (
      <DriftEvidence data={section.lastGood.data} saved refreshFailure={section.refreshFailure} />
    );
  } else if (section?.kind === "unavailable") {
    content = (
      <div className={styles.analysisUnavailable}>
        <p>{analysisUnavailableCopy(section.reason)}</p>
        {props.onRefresh !== null && shouldOfferRetry(section.reason) ? (
          <button type="button" className={styles.action} onClick={props.onRefresh}>
            Try again
          </button>
        ) : null}
      </div>
    );
  } else if (matches && props.analysis.status === "unavailable") {
    content = (
      <div className={styles.analysisUnavailable}>
        <p>The ride could not be analyzed right now.</p>
        {props.onRefresh === null ? null : (
          <button type="button" className={styles.action} onClick={props.onRefresh}>
            Try again
          </button>
        )}
      </div>
    );
  } else {
    content = (
      <p className={styles.analysisLoading} role="status">
        Checking ride streams…
      </p>
    );
  }
  return (
    <section className={styles.analysisPanel} aria-labelledby="aerobic-drift-title">
      <div className={styles.analysisHeading}>
        <div>
          <p className={styles.rideEyebrow}>Whole-ride analysis</p>
          <h2 id="aerobic-drift-title">Local aerobic drift estimate</h2>
        </div>
      </div>
      <p className={styles.analysisIntro}>
        Compares power per heartbeat in the first and second time-weighted halves. This local
        estimate is distinct from intervals.icu's cleaned power/HR metric.
      </p>
      {content}
    </section>
  );
}

export function RecentRidesStatePanel(props: {
  readonly panel: RecentRidesPanel;
  readonly units: UnitsPreference;
  readonly onOpen: (ride: RecentRide) => void;
  readonly registerButton: (id: string, node: HTMLButtonElement | null) => void;
}): ReactElement {
  return (
    <section className={styles.panel} data-panel="recent-rides" aria-label="Recent rides">
      <div className={styles.ridePanelHeading}>
        <h2 className={styles.panelTitle}>Recent rides</h2>
        {props.panel.kind === "computed" ? <span>{props.panel.windowDays} days</span> : null}
      </div>
      <div className={styles.panelBody}>
        {props.panel.kind === "unknown" ? (
          <p className={styles.empty}>{EMPTY_COPY[props.panel.reason]}</p>
        ) : (
          <ol className={styles.rideList}>
            {props.panel.items.map((ride) => {
              const dateTime = rideDateTime(ride);
              const duration = rideDuration(ride);
              const distance = rideDistance(ride, props.units);
              return (
                <li key={ride.id} className={styles.rideListItem}>
                  <button
                    ref={(node) => {
                      props.registerButton(ride.id, node);
                    }}
                    type="button"
                    className={styles.rideButton}
                    aria-label={`Review ${rideKind(ride).toLowerCase()} from ${dateTime}, ${duration}, ${distance}`}
                    onClick={() => {
                      props.onOpen(ride);
                    }}
                  >
                    <span className={styles.rideRail} aria-hidden="true" />
                    <span className={styles.ridePrimary}>
                      <strong>{rideKind(ride)}</strong>
                      <time dateTime={ride.localDate}>{dateTime}</time>
                    </span>
                    <span className={styles.rideStats}>
                      <span>{duration}</span>
                      <span>{distance}</span>
                    </span>
                    <span className={styles.rideArrow} aria-hidden="true">
                      →
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </section>
  );
}

export function RideDetailView(props: {
  readonly ride: RecentRide;
  readonly units: UnitsPreference;
  readonly analysis: RideAnalysisViewState;
  readonly onRefreshAnalysis: (() => void) | null;
  readonly onBack: () => void;
  readonly titleRef: Ref<HTMLHeadingElement>;
}): ReactElement {
  return (
    <Page
      title="Ride review"
      subtitle={formatDateLabel(props.ride.localDate)}
      titleRef={props.titleRef}
      action={
        <button type="button" className={styles.detailBack} onClick={props.onBack}>
          Back to training
        </button>
      }
    >
      <section className={styles.rideOverview} aria-labelledby="ride-overview-title">
        <p className={styles.rideEyebrow}>Recent ride</p>
        <h2 id="ride-overview-title">{rideKind(props.ride)}</h2>
        <RideSummary ride={props.ride} units={props.units} />
      </section>
      <AerobicDriftPanel
        rideId={props.ride.id}
        analysis={props.analysis}
        onRefresh={props.onRefreshAnalysis}
      />
    </Page>
  );
}
