import type {
  ActivityAnalysisData,
  ActivityAnalysisSection,
  AnalysisSection,
  RecentRide,
  RecentRidesPanel,
  UnitsPreference,
} from "@enduragent/coach-contract";
import type { ReactElement, ReactNode, Ref } from "react";
import type { RideAnalysisViewState } from "../../activity-analysis/controller.js";
import { formatDateLabel } from "../../training-context/format.js";
import { Page } from "../shared/Page.js";
import { analysisRefreshFailureCopy, analysisUnavailableCopy } from "./copy.js";
import { RideResponseReview } from "./RideResponseReview.js";
import styles from "./TrainingView.module.css";
import { ActivityExportControl } from "./TrainingExportControls.js";

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
  const refreshing = matches && props.analysis.loadingSections.includes("aerobic-drift");
  const clientRefreshUnavailable =
    matches && props.analysis.failedSections.includes("aerobic-drift");
  let content: ReactElement;
  if (section?.kind === "computed") {
    content = (
      <DriftEvidence
        data={section.data}
        saved={section.provenance.delivery === "persisted-cache"}
        refreshing={refreshing}
        clientRefreshUnavailable={clientRefreshUnavailable}
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
  } else if (clientRefreshUnavailable) {
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

const INTERVAL_KIND_COPY: Readonly<
  Record<ActivityAnalysisData["intervals"]["intervals"][number]["kind"], string>
> = {
  work: "Work",
  recovery: "Recovery",
  lap: "Lap",
  unknown: "Segment",
};

function unavailableMetric(): ReactElement {
  return <span aria-label="Unavailable">—</span>;
}

function durationMetric(seconds: number | null): ReactNode {
  return seconds === null ? unavailableMetric() : formatAnalysisDuration(seconds);
}

function distanceMetric(meters: number | null, units: UnitsPreference): ReactNode {
  if (meters === null) return unavailableMetric();
  return units === "imperial"
    ? `${(meters / 1_609.344).toFixed(1)} mi`
    : `${(meters / 1_000).toFixed(1)} km`;
}

function sensorMetric(average: number | null, maximum: number | null, unit: string): ReactNode {
  if (average === null && maximum === null) return unavailableMetric();
  if (average === null) return `${Math.round(maximum!)} max ${unit}`;
  if (maximum === null) return `${Math.round(average)} avg ${unit}`;
  return `${Math.round(average)} avg · ${Math.round(maximum)} max ${unit}`;
}

function AnalysisRetry(props: {
  readonly reason: Parameters<typeof analysisUnavailableCopy>[0] | null;
  readonly onRefresh: (() => void) | null;
  readonly fallback?: string;
}): ReactElement {
  const retry = props.reason === null || shouldOfferRetry(props.reason);
  return (
    <div className={styles.analysisUnavailable}>
      <p>
        {props.reason === null
          ? (props.fallback ?? "This analysis could not be loaded right now.")
          : analysisUnavailableCopy(props.reason)}
      </p>
      {props.onRefresh !== null && retry ? (
        <button type="button" className={styles.action} onClick={props.onRefresh}>
          Try again
        </button>
      ) : null}
    </div>
  );
}

function AnalysisEvidenceStatus(props: {
  readonly saved: boolean;
  readonly refreshing: boolean;
  readonly clientRefreshUnavailable: boolean;
  readonly refreshFailure?: Extract<
    AnalysisSection<unknown>,
    { readonly kind: "stale" }
  >["refreshFailure"];
}): ReactElement | null {
  const notice =
    props.refreshFailure !== undefined
      ? `Showing the saved result. ${analysisRefreshFailureCopy(props.refreshFailure.code)}`
      : props.clientRefreshUnavailable
        ? "Showing the previous result. The latest refresh did not finish."
        : props.refreshing
          ? "Refreshing this analysis…"
          : props.saved
            ? "Showing saved analysis."
            : null;
  return notice === null ? null : (
    <p className={props.refreshing ? styles.analysisRefresh : styles.analysisNotice} role="status">
      {notice}
    </p>
  );
}

function IntervalEvidence(props: {
  readonly data: ActivityAnalysisData["intervals"];
  readonly units: UnitsPreference;
  readonly saved: boolean;
  readonly refreshing: boolean;
  readonly clientRefreshUnavailable: boolean;
  readonly refreshFailure?: Extract<
    AnalysisSection<ActivityAnalysisData["intervals"]>,
    { readonly kind: "stale" }
  >["refreshFailure"];
}): ReactElement {
  return (
    <>
      <AnalysisEvidenceStatus
        saved={props.saved}
        refreshing={props.refreshing}
        clientRefreshUnavailable={props.clientRefreshUnavailable}
        refreshFailure={props.refreshFailure}
      />
      <p className={styles.analysisSource}>
        {props.data.source === "provider"
          ? "Ordered analysis from intervals.icu"
          : "Ordered laps from the local ride file"}
        {props.data.groups.length === 0 ? "" : ` · ${props.data.groups.length} groups`}
      </p>
      {props.data.intervals.length === 0 ? (
        <p className={styles.analysisEmpty}>No intervals or laps were found for this ride.</p>
      ) : (
        <ol className={styles.intervalList} aria-label="Ordered ride intervals and laps">
          {props.data.intervals.map((interval) => (
            <li key={interval.ordinal} className={styles.intervalItem} data-kind={interval.kind}>
              <div className={styles.intervalIdentity}>
                <span className={styles.intervalOrdinal} aria-hidden="true">
                  {interval.ordinal}
                </span>
                <div>
                  <span className={styles.intervalKind}>{INTERVAL_KIND_COPY[interval.kind]}</span>
                  <h3>{interval.label ?? `Interval ${interval.ordinal}`}</h3>
                  {interval.groupOrdinal === null ? null : <p>Group {interval.groupOrdinal}</p>}
                </div>
              </div>
              <dl className={styles.intervalMetrics}>
                <div>
                  <dt>Duration</dt>
                  <dd>{durationMetric(interval.movingSeconds ?? interval.elapsedSeconds)}</dd>
                </div>
                <div>
                  <dt>Distance</dt>
                  <dd>{distanceMetric(interval.distanceMeters, props.units)}</dd>
                </div>
                <div>
                  <dt>Power</dt>
                  <dd>
                    {sensorMetric(interval.averagePowerWatts, interval.maximumPowerWatts, "W")}
                  </dd>
                </div>
                <div>
                  <dt>Heart rate</dt>
                  <dd>
                    {sensorMetric(
                      interval.averageHeartRateBpm,
                      interval.maximumHeartRateBpm,
                      "bpm",
                    )}
                  </dd>
                </div>
              </dl>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

function IntervalReviewPanel(props: {
  readonly rideId: string;
  readonly analysis: RideAnalysisViewState;
  readonly units: UnitsPreference;
  readonly onRefresh: (() => void) | null;
}): ReactElement {
  const matches = props.analysis.activityId === props.rideId;
  const section = matches ? props.analysis.sections.intervals : undefined;
  const refreshing = matches && props.analysis.loadingSections.includes("intervals");
  const failed = matches && props.analysis.failedSections.includes("intervals");
  let content: ReactElement;
  if (section?.kind === "computed") {
    content = (
      <IntervalEvidence
        data={section.data}
        units={props.units}
        saved={section.provenance.delivery === "persisted-cache"}
        refreshing={refreshing}
        clientRefreshUnavailable={failed}
      />
    );
  } else if (section?.kind === "stale") {
    content = (
      <IntervalEvidence
        data={section.lastGood.data}
        units={props.units}
        saved
        refreshing={false}
        clientRefreshUnavailable={false}
        refreshFailure={section.refreshFailure}
      />
    );
  } else if (section?.kind === "unavailable") {
    content = <AnalysisRetry reason={section.reason} onRefresh={props.onRefresh} />;
  } else if (failed) {
    content = (
      <AnalysisRetry
        reason={null}
        fallback="Intervals and laps could not be loaded right now."
        onRefresh={props.onRefresh}
      />
    );
  } else {
    content = (
      <p className={styles.analysisLoading} role="status">
        Checking ride intervals…
      </p>
    );
  }
  return (
    <section className={styles.analysisPanel} aria-labelledby="interval-review-title">
      <p className={styles.rideEyebrow}>Ordered ride segments</p>
      <h2 id="interval-review-title" className={styles.analysisTitle}>
        Intervals and laps
      </h2>
      <p className={styles.analysisIntro}>
        Shows recorded segments in order. Missing metrics stay unavailable, and no planned workout
        targets are inferred.
      </p>
      {content}
    </section>
  );
}

function BestEffortEvidence(props: {
  readonly data: ActivityAnalysisData["bestEfforts"];
  readonly units: UnitsPreference;
  readonly saved: boolean;
  readonly refreshing: boolean;
  readonly clientRefreshUnavailable: boolean;
  readonly refreshFailure?: Extract<
    AnalysisSection<ActivityAnalysisData["bestEfforts"]>,
    { readonly kind: "stale" }
  >["refreshFailure"];
}): ReactElement {
  return (
    <>
      <AnalysisEvidenceStatus
        saved={props.saved}
        refreshing={props.refreshing}
        clientRefreshUnavailable={props.clientRefreshUnavailable}
        refreshFailure={props.refreshFailure}
      />
      <p className={styles.analysisSource}>
        This ride · power · {formatAnalysisDuration(props.data.scope.durationSeconds)} · equal
        efforts rank the earlier start first
      </p>
      {props.data.efforts.length === 0 ? (
        <p className={styles.analysisEmpty}>No five-minute power efforts were found.</p>
      ) : (
        <ol className={styles.effortList} aria-label="Five-minute power efforts in this ride">
          {props.data.efforts.map((effort) => (
            <li key={effort.rank} className={styles.effortItem}>
              <span className={styles.effortRank}>#{effort.rank}</span>
              <strong>{Math.round(effort.averageWatts)} W</strong>
              <span>{distanceMetric(effort.distanceMeters, props.units)}</span>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

function BestEffortPanel(props: {
  readonly rideId: string;
  readonly analysis: RideAnalysisViewState;
  readonly units: UnitsPreference;
  readonly onRefresh: (() => void) | null;
}): ReactElement {
  const matches = props.analysis.activityId === props.rideId;
  const section = matches ? props.analysis.sections.bestEfforts : undefined;
  const refreshing = matches && props.analysis.loadingSections.includes("best-efforts");
  const failed = matches && props.analysis.failedSections.includes("best-efforts");
  let content: ReactElement;
  if (section?.kind === "computed") {
    content = (
      <BestEffortEvidence
        data={section.data}
        units={props.units}
        saved={section.provenance.delivery === "persisted-cache"}
        refreshing={refreshing}
        clientRefreshUnavailable={failed}
      />
    );
  } else if (section?.kind === "stale") {
    content = (
      <BestEffortEvidence
        data={section.lastGood.data}
        units={props.units}
        saved
        refreshing={false}
        clientRefreshUnavailable={false}
        refreshFailure={section.refreshFailure}
      />
    );
  } else if (section?.kind === "unavailable") {
    content = <AnalysisRetry reason={section.reason} onRefresh={props.onRefresh} />;
  } else if (failed) {
    content = (
      <AnalysisRetry
        reason={null}
        fallback="Five-minute efforts could not be loaded right now."
        onRefresh={props.onRefresh}
      />
    );
  } else {
    content = (
      <p className={styles.analysisLoading} role="status">
        Checking five-minute efforts…
      </p>
    );
  }
  return (
    <section className={styles.analysisPanel} aria-labelledby="best-efforts-title">
      <p className={styles.rideEyebrow}>Selected-ride scope</p>
      <h2 id="best-efforts-title" className={styles.analysisTitle}>
        Five-minute best efforts
      </h2>
      <p className={styles.analysisIntro}>
        Ranks measured five-minute power efforts from this ride only. It does not compare against
        other rides or all-history results.
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
  readonly onRefreshAnalysis: ((sections: readonly ActivityAnalysisSection[]) => void) | null;
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
      <ActivityExportControl canonicalActivityId={props.ride.id} localDate={props.ride.localDate} />
      <AerobicDriftPanel
        rideId={props.ride.id}
        analysis={props.analysis}
        onRefresh={
          props.onRefreshAnalysis === null
            ? null
            : () => props.onRefreshAnalysis?.(["aerobic-drift"])
        }
      />
      <IntervalReviewPanel
        rideId={props.ride.id}
        analysis={props.analysis}
        units={props.units}
        onRefresh={
          props.onRefreshAnalysis === null ? null : () => props.onRefreshAnalysis?.(["intervals"])
        }
      />
      <BestEffortPanel
        rideId={props.ride.id}
        analysis={props.analysis}
        units={props.units}
        onRefresh={
          props.onRefreshAnalysis === null
            ? null
            : () => props.onRefreshAnalysis?.(["best-efforts"])
        }
      />
      <RideResponseReview
        rideId={props.ride.id}
        analysis={props.analysis}
        onRefresh={props.onRefreshAnalysis}
      />
    </Page>
  );
}
