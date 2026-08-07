import type { RecentRide, RecentRidesPanel, UnitsPreference } from "@enduragent/coach-contract";
import type { ReactElement, Ref } from "react";
import { formatDateLabel } from "../../training-context/format.js";
import { Page } from "../shared/Page.js";
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
    </Page>
  );
}
