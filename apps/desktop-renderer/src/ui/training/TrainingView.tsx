import type {
  CompletedActivityWeek,
  TrainingHistoryComputed,
  TrainingHistoryPanel,
  TrainingHistoryRide,
  UnitsPreference,
} from "@enduragent/coach-contract";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "../../components/ui/button";
import { formatCivilDate } from "../../lib/date";
import { rideImportStatusCopy } from "../../ride-import";
import { rideImportStatusSuppressed } from "../../state/onboarding-slice";
import { useEnduragentStore } from "../../state/store";
import {
  formatDistance,
  formatRidingDuration,
  formatWholeNumber,
} from "../../training-context/format";
import { Page } from "../shared/Page";
import { TRAINING_DEGRADED_COPY, TRAINING_HISTORY_COPY, trainingStatusCopy } from "./copy";
import { overviewStyles as styles } from "./overviewStyles";
import { PowerProgressContent } from "./PowerProgressPanel";
import { RideDetailView, trainingRideDateTime, trainingRideKind } from "./RideReview";

type Period = "anchor" | "previous";
type WeekMetric = CompletedActivityWeek["totals"][keyof CompletedActivityWeek["totals"]];

function effectiveHistory(panel: TrainingHistoryPanel): TrainingHistoryComputed | null {
  if (panel.kind === "unavailable") return null;
  return panel.kind === "stale" ? panel.lastGood : panel;
}

function selectedWeek(history: TrainingHistoryComputed, period: Period): CompletedActivityWeek {
  return period === "previous" && history.previousWeek !== null
    ? history.previousWeek
    : history.anchorWeek;
}

function periodLabel(history: TrainingHistoryComputed, period: Period, retained: boolean): string {
  if (period === "previous") return TRAINING_HISTORY_COPY.previous;
  return retained || history.displayMode === "last-recorded"
    ? TRAINING_HISTORY_COPY.lastRecorded
    : TRAINING_HISTORY_COPY.current;
}

function coverageDate(history: TrainingHistoryComputed): string | null {
  if (history.coverage.kind === "contiguous") return history.coverage.through;
  if (history.coverage.kind === "sparse") return history.coverage.latestKnownRideDate;
  return history.coverage.provenThrough ?? history.coverage.observedThrough;
}

function dataWarning(
  panel: TrainingHistoryPanel,
  history: TrainingHistoryComputed,
  week: CompletedActivityWeek,
): string | null {
  if (panel.kind === "stale") return TRAINING_HISTORY_COPY.refreshFailure;
  if (history.coverage.kind === "sparse") return TRAINING_HISTORY_COPY.sparse;
  if (history.displayMode === "last-recorded") {
    return history.coverage.kind === "incomplete"
      ? TRAINING_HISTORY_COPY.outOfDateIncomplete
      : TRAINING_HISTORY_COPY.outOfDate;
  }
  if (week.coverage.kind === "complete") return null;
  if (week.coverage.reason === "coverage-lag") return TRAINING_HISTORY_COPY.coverageLag;
  if (week.coverage.reason === "sparse-imports") return TRAINING_HISTORY_COPY.sparse;
  return TRAINING_HISTORY_COPY.incomplete;
}

function metricCopy(
  metric: WeekMetric,
  format: (value: number) => string,
  ridesExist: boolean,
): string {
  if (metric.kind === "unavailable") return ridesExist ? "Not recorded" : "Unavailable";
  const value = format(metric.value);
  return metric.kind === "partial" ? `At least ${value}` : value;
}

function rideCountCopy(value: number): string {
  return `${formatWholeNumber(value)} ${value === 1 ? "ride" : "rides"}`;
}

function weekRangeLabel(week: CompletedActivityWeek): string {
  const startMonth = formatCivilDate(week.window.start, { month: "short" });
  const endMonth = formatCivilDate(week.window.end, { month: "short" });
  const start = formatCivilDate(week.window.start, { day: "numeric", month: "short" });
  const end = formatCivilDate(
    week.window.end,
    startMonth === endMonth ? { day: "numeric" } : { day: "numeric", month: "short" },
  );
  return `${start}–${end}`;
}

function noticeCoverage(
  panel: TrainingHistoryPanel,
  history: TrainingHistoryComputed,
  week: CompletedActivityWeek,
): string | null {
  if (panel.kind !== "stale" && week.coverage.kind !== "incomplete") return null;
  const through =
    week.coverage.kind === "incomplete" ? week.coverage.recordedThrough : coverageDate(history);
  return through === null ? null : `${TRAINING_HISTORY_COPY.coverage} ${formatCivilDate(through)}`;
}

function Trend(props: { readonly week: CompletedActivityWeek }): ReactElement {
  const trend = props.week.trend;
  if (trend.kind === "unavailable") {
    const reason = {
      "limited-history": TRAINING_HISTORY_COPY.limitedHistory,
      "incomplete-source": TRAINING_HISTORY_COPY.incompleteTrend,
      "missing-duration": TRAINING_HISTORY_COPY.missingDuration,
    }[trend.reason];
    return (
      <figure className={styles.trend} aria-labelledby="training-trend-title">
        <figcaption id="training-trend-title" className={styles.trendCaption}>
          <span>{TRAINING_HISTORY_COPY.trendLabel}</span>{" "}
          <span>{TRAINING_HISTORY_COPY.trendPeriod}</span>
        </figcaption>
        <p className={styles.trendUnavailable}>{TRAINING_HISTORY_COPY.trendUnavailable}</p>
        <p className={styles.trendReason}>{reason}</p>
      </figure>
    );
  }
  const maximum = Math.max(...trend.buckets.map((bucket) => bucket.ridingSeconds), 1);
  return (
    <figure className={styles.trend} aria-labelledby="training-trend-title">
      <figcaption id="training-trend-title" className={styles.trendCaption}>
        <span>{TRAINING_HISTORY_COPY.trendLabel}</span>{" "}
        <span>{TRAINING_HISTORY_COPY.trendPeriod}</span>
      </figcaption>
      <div className={styles.trendBars} aria-hidden="true">
        {trend.buckets.map((bucket) => (
          <span className={styles.trendColumn} key={bucket.window.start}>
            <span
              className={styles.trendBar}
              style={{ height: `${(bucket.ridingSeconds / maximum) * 75}%` }}
            />
            <span className={styles.trendLabel}>
              {formatCivilDate(bucket.window.start, { day: "numeric", month: "numeric" })}
            </span>
          </span>
        ))}
      </div>
      <table className={styles.srOnly}>
        <caption>{TRAINING_HISTORY_COPY.trendTitle} data</caption>
        <thead>
          <tr>
            <th scope="col">Week</th>
            <th scope="col">Rides</th>
            <th scope="col">Riding time</th>
          </tr>
        </thead>
        <tbody>
          {trend.buckets.map((bucket) => (
            <tr key={bucket.window.start}>
              <th scope="row">
                {formatCivilDate(bucket.window.start)} to {formatCivilDate(bucket.window.end)}
              </th>
              <td>{rideCountCopy(bucket.rideCount)}</td>
              <td>{formatRidingDuration(bucket.ridingSeconds)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

function WeeklySummary(props: {
  readonly history: TrainingHistoryComputed;
  readonly retained: boolean;
  readonly period: Period;
  readonly week: CompletedActivityWeek;
  readonly units: UnitsPreference;
}): ReactElement {
  const ridesExist = props.week.rides.items.length > 0 || props.week.rides.count.value > 0;
  const label = periodLabel(props.history, props.period, props.retained);
  return (
    <section
      className={styles.weekSection}
      data-panel="weekly-summary"
      aria-labelledby="weekly-summary-title"
    >
      <h2 id="weekly-summary-title" className={styles.srOnly}>
        Weekly summary
      </h2>
      <div className={styles.weekHero}>
        <div className={styles.weekFacts}>
          <p className={styles.weekEyebrow}>{label}</p>
          <p className={styles.weekTime} data-summary-metric="riding-time">
            {metricCopy(props.week.totals.ridingSeconds, formatRidingDuration, ridesExist)}
          </p>
          <p className={styles.weekMetrics}>
            <span data-summary-metric="ride-count">
              {metricCopy(props.week.totals.rideCount, rideCountCopy, ridesExist)}
            </span>
            {" · "}
            <span data-summary-metric="distance">
              {metricCopy(
                props.week.totals.distanceMeters,
                (value) => formatDistance(value, props.units),
                ridesExist,
              )}
            </span>
            {" · "}
            <span data-summary-metric="load">
              Load {metricCopy(props.week.totals.load, formatWholeNumber, ridesExist)}
            </span>
          </p>
        </div>
        <Trend week={props.week} />
      </div>
    </section>
  );
}

function calloutReason(week: CompletedActivityWeek, rideId: string): string | null {
  const callout = week.callout;
  if (callout === null || callout.rideId !== rideId) return null;
  return `Longest recorded ride in the 28 days ending ${formatCivilDate(callout.window.end)}`;
}

function RideRow(props: {
  readonly ride: TrainingHistoryRide;
  readonly reason: string | null;
  readonly units: UnitsPreference;
  readonly onOpen: () => void;
  readonly register: (node: HTMLButtonElement | null) => void;
}): ReactElement {
  const title = props.ride.title ?? trainingRideKind(props.ride);
  const dateTime = trainingRideDateTime(props.ride);
  return (
    <li
      className={styles.historyRideItem}
      data-callout={props.reason === null ? undefined : "true"}
    >
      <button
        ref={props.register}
        type="button"
        className={styles.historyRideButton}
        aria-label={`Open ride review: ${title}, ${dateTime}`}
        onClick={props.onOpen}
      >
        <span className={styles.historyRideMain}>
          <span className={styles.historyRideTitle}>
            <strong>{title}</strong>
            {props.reason === null ? null : <span>Worth a look</span>}
          </span>
          <time dateTime={props.ride.localDate}>{dateTime}</time>
          {props.reason === null ? null : (
            <span className={styles.historyRideReason}>{props.reason}</span>
          )}
        </span>
        <span className={styles.historyRideStats}>
          {props.ride.ridingSeconds === null ? null : (
            <span>{formatRidingDuration(props.ride.ridingSeconds)}</span>
          )}
          {props.ride.distanceMeters === null ? null : (
            <span>{formatDistance(props.ride.distanceMeters, props.units)}</span>
          )}
        </span>
        {props.ride.load === null ? null : (
          <span className={styles.historyRideLoad}>Load {formatWholeNumber(props.ride.load)}</span>
        )}
        <span className={styles.historyRideArrow} aria-hidden="true">
          →
        </span>
      </button>
    </li>
  );
}

function emptyRidesCopy(
  history: TrainingHistoryComputed,
  retained: boolean,
  period: Period,
): string {
  if (period === "previous") return TRAINING_HISTORY_COPY.previousEmpty;
  return retained || history.displayMode === "last-recorded"
    ? TRAINING_HISTORY_COPY.lastRecordedEmpty
    : TRAINING_HISTORY_COPY.currentEmpty;
}

function RecentRides(props: {
  readonly history: TrainingHistoryComputed;
  readonly retained: boolean;
  readonly period: Period;
  readonly week: CompletedActivityWeek;
  readonly units: UnitsPreference;
  readonly onOpen: (ride: TrainingHistoryRide) => void;
  readonly onPreviousWeek: () => void;
  readonly registerButton: (id: string, node: HTMLButtonElement | null) => void;
}): ReactElement {
  const truncation =
    props.week.rides.truncated && props.week.rides.items.length > 0
      ? props.week.rides.count.kind === "at-least"
        ? `Showing ${props.week.rides.items.length} of at least ${props.week.rides.count.value} recorded rides.`
        : `Showing ${props.week.rides.items.length} of ${props.week.rides.count.value} recorded rides.`
      : null;
  return (
    <section
      className={styles.ridesSection}
      data-panel="recent-rides"
      aria-labelledby="recent-rides-title"
    >
      <div className={styles.ridesHeading}>
        <h2 id="recent-rides-title">Recent rides</h2>
        {props.week.rides.items.length === 0 ? null : (
          <span>{TRAINING_HISTORY_COPY.newestFirst}</span>
        )}
      </div>
      {props.week.rides.items.length === 0 ? (
        <p className={styles.historyEmpty}>
          {emptyRidesCopy(props.history, props.retained, props.period)}
        </p>
      ) : (
        <ol className={styles.historyRideList}>
          {props.week.rides.items.map((ride) => (
            <RideRow
              key={ride.id}
              ride={ride}
              reason={calloutReason(props.week, ride.id)}
              units={props.units}
              onOpen={() => props.onOpen(ride)}
              register={(node) => props.registerButton(ride.id, node)}
            />
          ))}
        </ol>
      )}
      {truncation === null ? null : <p className={styles.truncation}>{truncation}</p>}
      {props.period !== "anchor" || props.retained || props.history.previousWeek === null ? null : (
        <div className={styles.moreHistory}>
          <Button
            type="button"
            variant="outline"
            className={styles.moreHistoryButton}
            data-parity="rides-previous-week"
            onClick={props.onPreviousWeek}
          >
            {TRAINING_HISTORY_COPY.previous}
          </Button>
        </div>
      )}
    </section>
  );
}

function PowerProgressStatePanel(props: {
  readonly panel: Parameters<typeof PowerProgressContent>[0]["panel"];
}): ReactElement {
  return (
    <section className={styles.panel} data-panel="power-progress" aria-label="Power progress">
      <h2 className={styles.panelTitle}>Power progress</h2>
      <div className={styles.panelBody}>
        <PowerProgressContent panel={props.panel} />
      </div>
    </section>
  );
}

function PeriodNavigation(props: {
  readonly history: TrainingHistoryComputed;
  readonly period: Period;
  readonly retained: boolean;
  readonly onChange: (period: Period) => void;
}): ReactElement {
  return (
    <div className={styles.periodGroup} role="group" aria-label="Completed riding period">
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        className={styles.periodButton}
        aria-label={TRAINING_HISTORY_COPY.previous}
        disabled={
          props.retained || props.period === "previous" || props.history.previousWeek === null
        }
        onClick={() => props.onChange("previous")}
      >
        <ChevronLeft className="size-4" aria-hidden="true" />
      </Button>
      <Button
        type="button"
        variant="outline"
        size="xs"
        className={styles.periodButton}
        aria-pressed={props.period === "anchor"}
        disabled={props.retained}
        onClick={() => props.onChange("anchor")}
      >
        {periodLabel(props.history, "anchor", props.retained)}
      </Button>
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        className={styles.periodButton}
        aria-label={TRAINING_HISTORY_COPY.next}
        disabled={props.retained || props.period === "anchor"}
        onClick={() => props.onChange("anchor")}
      >
        <ChevronRight className="size-4" aria-hidden="true" />
      </Button>
    </div>
  );
}

function DataNotice(props: {
  readonly coverage: string | null;
  readonly notice: string;
}): ReactElement {
  return (
    <p className={styles.dataNotice}>
      {props.coverage === null ? null : (
        <span className={styles.dataNoticeCoverage}>{props.coverage}</span>
      )}
      <span>{props.notice}</span>
    </p>
  );
}

function RideImportStatus(): ReactElement {
  const state = useEnduragentStore((store) => store.rideImport);
  const suppressed = useEnduragentStore(rideImportStatusSuppressed);
  const visible = state.status !== "idle" && !suppressed;
  const progress = visible && state.status === "running" ? state.progress : null;
  const copy = visible ? rideImportStatusCopy(state) : "";
  return (
    <>
      {visible ? (
        <section
          className={styles.importStatus}
          data-panel="ride-import"
          aria-label="Import ride files"
        >
          <h2>Import ride files</h2>
          {progress === null ? null : (
            <p className={styles.meta}>
              {progress.params.event.completed} of {progress.params.event.total} files processed
            </p>
          )}
          <p className={styles.support} aria-hidden="true">
            {copy}
          </p>
        </section>
      ) : null}
      <p
        id="ride-import-status"
        className={`${styles.srOnly} ride-import-status`}
        data-state={visible ? state.status : "idle"}
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {copy}
      </p>
    </>
  );
}

function UnavailableHistory(): ReactElement {
  return (
    <>
      <section
        className={styles.weekSection}
        data-panel="weekly-summary"
        aria-labelledby="weekly-summary-title"
      >
        <h2 id="weekly-summary-title" className={styles.srOnly}>
          Weekly summary
        </h2>
        <p className={styles.historyEmpty}>{TRAINING_HISTORY_COPY.unavailable}</p>
      </section>
      <section
        className={styles.ridesSection}
        data-panel="recent-rides"
        aria-labelledby="recent-rides-title"
      >
        <div className={styles.ridesHeading}>
          <h2 id="recent-rides-title">Recent rides</h2>
        </div>
        <p className={styles.historyEmpty}>{TRAINING_HISTORY_COPY.unknownRides}</p>
      </section>
    </>
  );
}

function reviewCalloutReason(history: TrainingHistoryComputed, rideId: string): string | null {
  const anchor = calloutReason(history.anchorWeek, rideId);
  if (anchor !== null) return anchor;
  return history.previousWeek === null ? null : calloutReason(history.previousWeek, rideId);
}

export function TrainingView(): ReactElement {
  const training = useEnduragentStore((store) => store.training);
  const selectedRide = useEnduragentStore((store) => store.selectedRide);
  const openRide = useEnduragentStore((store) => store.openRide);
  const closeRide = useEnduragentStore((store) => store.closeRide);
  const rideAnalysis = useEnduragentStore((store) => store.rideAnalysis);
  const rideAnalysisActions = useEnduragentStore((store) => store.rideAnalysisActions);
  const [period, setPeriod] = useState<Period>("anchor");
  const rideButtons = useRef(new Map<string, HTMLButtonElement>());
  const previousRideId = useRef<string | null>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const panel = training.trainingContext.trainingHistory;
  const history = effectiveHistory(panel);
  const retained = panel.kind === "stale";
  const resolvedRide = selectedRide;

  useEffect(() => {
    if (period === "previous" && history?.previousWeek === null) setPeriod("anchor");
  }, [history?.previousWeek, period]);

  useLayoutEffect(() => {
    const currentRideId = resolvedRide?.id ?? null;
    if (currentRideId !== null && previousRideId.current !== currentRideId) {
      title.current?.focus();
    } else if (currentRideId === null && previousRideId.current !== null) {
      (rideButtons.current.get(previousRideId.current) ?? title.current)?.focus();
    } else {
      const element = title.current;
      if (element !== null) {
        const owner = element.ownerDocument;
        const active = owner.activeElement;
        if (active === null || active === owner.body || active === owner.documentElement) {
          element.focus();
        }
      }
    }
    previousRideId.current = currentRideId;
  }, [resolvedRide?.id]);

  const activeWeek = history === null ? null : selectedWeek(history, period);
  const warning =
    history === null || activeWeek === null ? null : dataWarning(panel, history, activeWeek);
  const statusWarning =
    training.status === "unavailable" || training.status === "refresh-unavailable"
      ? trainingStatusCopy(training.status)
      : null;
  const notice =
    statusWarning ??
    warning ??
    (training.metadata?.degraded === true ? TRAINING_DEGRADED_COPY : null);
  const coverage =
    history === null || activeWeek === null ? null : noticeCoverage(panel, history, activeWeek);
  const label = history === null ? null : periodLabel(history, period, retained);
  const announcement = useMemo(
    () => (label === null ? null : notice === null ? label : `${label}. ${notice}`),
    [label, notice],
  );

  if (resolvedRide !== null) {
    return (
      <RideDetailView
        key={resolvedRide.id}
        ride={resolvedRide}
        units={training.unitsPreference.value}
        analysis={rideAnalysis}
        calloutReason={history === null ? null : reviewCalloutReason(history, resolvedRide.id)}
        onStartAnalysis={rideAnalysisActions === null ? null : () => rideAnalysisActions.start()}
        onRefreshAnalysis={
          rideAnalysisActions === null ? null : (sections) => rideAnalysisActions.refresh(sections)
        }
        titleRef={title}
        onBack={closeRide}
      />
    );
  }

  let historyContent: ReactNode;
  if (history === null || activeWeek === null) {
    historyContent = (
      <>
        {notice === null ? null : <DataNotice coverage={coverage} notice={notice} />}
        <UnavailableHistory />
      </>
    );
  } else {
    historyContent = (
      <>
        <p className={styles.srOnly} role="status" aria-live="polite" aria-atomic="true">
          {announcement}
        </p>
        {notice === null ? null : <DataNotice coverage={coverage} notice={notice} />}
        <WeeklySummary
          history={history}
          retained={retained}
          period={period}
          week={activeWeek}
          units={training.unitsPreference.value}
        />
        <RecentRides
          history={history}
          retained={retained}
          period={period}
          week={activeWeek}
          units={training.unitsPreference.value}
          onOpen={openRide}
          onPreviousWeek={() => setPeriod("previous")}
          registerButton={(id, node) => {
            if (node === null) rideButtons.current.delete(id);
            else rideButtons.current.set(id, node);
          }}
        />
      </>
    );
  }

  return (
    <Page
      title="Training"
      subtitle={activeWeek === null ? undefined : weekRangeLabel(activeWeek)}
      titleRef={title}
      busy={training.status === "loading"}
      action={
        history === null ? undefined : (
          <PeriodNavigation
            history={history}
            period={period}
            retained={retained}
            onChange={setPeriod}
          />
        )
      }
    >
      {historyContent}
      <PowerProgressStatePanel panel={training.trainingContext.performanceProgress} />
      <RideImportStatus />
    </Page>
  );
}
