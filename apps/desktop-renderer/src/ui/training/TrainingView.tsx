import type {
  AdherencePanel,
  AnchorZonesPanel,
  CyclingLoadPanel,
  PlanPanel,
  PowerProgressPanel,
  RecentRide,
  WellnessTrendPanel,
} from "@enduragent/coach-contract";
import { TriangleAlert } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";
import { Button } from "../../components/ui/button";
import { rideImportStatusCopy } from "../../ride-import";
import { rideImportStatusSuppressed } from "../../state/onboarding-slice";
import {
  setManualSyncFocusFallback,
  setManualSyncFocusTarget,
} from "../../state/manual-sync-focus";
import { useEnduragentStore } from "../../state/store";
import {
  sourceRestrictionSummary,
  STRAVA_RESTRICTION_DESKTOP_COPY,
} from "../../training-context/manual-sync";
import {
  formatDateLabel,
  formatPercentage,
  formatSleepDuration,
  formatUtcTimestamp,
  formatWholeNumber,
} from "../../training-context/format";
import { Page } from "../shared/Page";
import {
  MAX_VISIBLE_PLAN_ITEMS,
  RIDE_IMPORT_DESCRIPTION,
  TRAINING_UNKNOWN_COPY,
  WELLNESS_LABELS,
  stalenessCopy,
  trainingStatusCopy,
} from "./copy";
import { overviewStyles as styles } from "./overviewStyles";
import { PowerProgressContent } from "./PowerProgressPanel";
import { RecentRidesStatePanel, RideDetailView } from "./RideReview";
import { WellnessSparkline } from "./WellnessSparkline";
import { WorkoutArchiveExportControl } from "./TrainingExportControls";
import {
  STRAVA_RESTRICTION_CARD_ID,
  takeTrainingRestrictionFocusRequest,
} from "./restriction-focus";

function Panel(props: {
  readonly name: string;
  readonly title: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <section className={styles.panel} data-panel={props.name} aria-label={props.title}>
      <h2 className={styles.panelTitle}>{props.title}</h2>
      <div className={styles.panelBody}>{props.children}</div>
    </section>
  );
}

function Unknown(props: { readonly reason: keyof typeof TRAINING_UNKNOWN_COPY }): ReactElement {
  return <p className={styles.empty}>{TRAINING_UNKNOWN_COPY[props.reason]}</p>;
}

function PowerProgressStatePanel(props: { readonly panel: PowerProgressPanel }): ReactElement {
  return (
    <Panel name="power-progress" title="Power progress">
      <PowerProgressContent panel={props.panel} />
    </Panel>
  );
}

function SyncPanel(props: {
  readonly restrictionCard: RefObject<HTMLDivElement | null>;
}): ReactElement {
  const metadata = useEnduragentStore((store) => store.training.metadata);
  const sync = useEnduragentStore((store) => store.sync);
  const actions = useEnduragentStore((store) => store.syncActions);
  const action = useRef<HTMLButtonElement>(null);
  const message = useRef<HTMLParagraphElement>(null);
  const synced = metadata?.lastSynced ?? null;
  const syncedCopy = synced === null ? null : formatUtcTimestamp(synced);
  const syncedInstant =
    synced === null || syncedCopy === "Unknown sync time" ? null : new Date(synced).toISOString();
  const restriction = sourceRestrictionSummary(sync.droppedActivities, "STRAVA");

  useEffect(() => {
    setManualSyncFocusFallback(message.current);
    return () => {
      setManualSyncFocusFallback(null);
    };
  }, []);

  return (
    <Panel name="sync" title="Sync">
      <div className={`${styles.metadata} training-metadata`}>
        {metadata === null ? null : (
          <>
            <p className={`${styles.meta} training-metadata-item`}>
              As of {formatDateLabel(metadata.lastUpdated)}
            </p>
            <p className={styles.badge}>{metadata.freshness}</p>
            {metadata.degraded ? (
              <p className={`${styles.meta} training-metadata-item`}>Data may be incomplete</p>
            ) : null}
            {syncedCopy === null ? null : (
              <p className={`${styles.meta} training-metadata-item`}>
                Last synced{" "}
                {syncedInstant === null ? (
                  syncedCopy
                ) : (
                  <time dateTime={syncedInstant}>{syncedCopy}</time>
                )}
              </p>
            )}
          </>
        )}
      </div>
      <div className={styles.syncRow} data-tone={sync.tone}>
        <Button
          type="button"
          ref={action}
          variant="outline"
          className="training-sync-action"
          disabled={sync.disabled || actions === null}
          aria-busy={sync.busy ? "true" : undefined}
          onClick={(event) => {
            const keyboard = event.detail === 0;
            setManualSyncFocusTarget(keyboard ? action.current : null);
            actions?.request(keyboard ? "keyboard" : "pointer");
          }}
        >
          {sync.label}
        </Button>
        <p
          ref={message}
          tabIndex={-1}
          className={`${styles.syncMessage} training-sync-message`}
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {sync.message}
        </p>
      </div>
      {restriction === null ? null : (
        <div
          ref={props.restrictionCard}
          id={STRAVA_RESTRICTION_CARD_ID}
          tabIndex={-1}
          className="mt-4 rounded-xl border border-line bg-surface p-4 shadow-elev-1"
        >
          <div className="flex items-start gap-2.5">
            <TriangleAlert
              size={17}
              strokeWidth={1.8}
              className="mt-px flex-none text-warn"
              aria-hidden="true"
            />
            <div className="min-w-0">
              <p className="m-0 text-sm font-semibold text-ink">
                {STRAVA_RESTRICTION_DESKTOP_COPY.cardTitle(restriction.count, restriction.total)}
              </p>
              <p className="mt-1 text-[12.5px] leading-relaxed text-ink-2">
                {STRAVA_RESTRICTION_DESKTOP_COPY.cause}
              </p>
            </div>
          </div>
          <div className="mt-3 grid gap-2.5 border-t border-line pt-3">
            <div className="flex items-start gap-2.5">
              <span className="flex size-[18px] flex-none items-center justify-center rounded-full bg-brand/15 text-[10px] font-semibold text-brand">
                1
              </span>
              <p className="m-0 text-[12.5px] leading-relaxed text-ink-2">
                <strong className="font-semibold text-ink">For future rides — </strong>
                {STRAVA_RESTRICTION_DESKTOP_COPY.future}
              </p>
            </div>
            <div className="flex items-start gap-2.5">
              <span className="flex size-[18px] flex-none items-center justify-center rounded-full bg-brand/15 text-[10px] font-semibold text-brand">
                2
              </span>
              <p className="m-0 text-[12.5px] leading-relaxed text-ink-2">
                <strong className="font-semibold text-ink">For past rides — </strong>
                {STRAVA_RESTRICTION_DESKTOP_COPY.past}
              </p>
            </div>
          </div>
        </div>
      )}
    </Panel>
  );
}

function AnchorPanel(props: { readonly panel: AnchorZonesPanel }): ReactElement {
  if (props.panel.kind === "unknown") {
    return (
      <Panel name="anchor" title="Current cycling anchor">
        <Unknown reason={props.panel.reason} />
      </Panel>
    );
  }
  const { anchor, asOf, zones } = props.panel;
  return (
    <Panel name="anchor" title="Current cycling anchor">
      <p className={styles.value}>{formatWholeNumber(anchor.watts)} W</p>
      <p className={styles.badge} data-band={anchor.stalenessBand}>
        {stalenessCopy(anchor.stalenessBand, anchor.ageDays)}
      </p>
      <p className={styles.meta}>
        As of {formatDateLabel(asOf)} · {anchor.source} · {anchor.confidence}
      </p>
      <h3 className={styles.subheading}>Power zones</h3>
      <dl className={styles.zones}>
        {zones.map((zone) => (
          <div className={styles.zone} key={zone.name}>
            <dt className={styles.zoneName} data-overlaps={zone.overlaps ? "true" : undefined}>
              {zone.name}
            </dt>
            <dd className={styles.zoneRange}>{zone.range}</dd>
          </div>
        ))}
      </dl>
    </Panel>
  );
}

function LoadPanel(props: { readonly panel: CyclingLoadPanel }): ReactElement {
  if (props.panel.kind === "unknown") {
    return (
      <Panel name="load" title="Cycling Load">
        <Unknown reason={props.panel.reason} />
      </Panel>
    );
  }
  return (
    <Panel name="load" title="Cycling Load">
      <p className={styles.value}>{formatWholeNumber(props.panel.value)}</p>
      <p className={styles.meta}>From intervals.icu · 7 days</p>
      <p className={styles.support}>{props.panel.activityCount} cycling activities</p>
      {props.panel.missingLoadCount > 0 ? (
        <p className={styles.support}>
          {props.panel.missingLoadCount} cycling activities have no platform Load
        </p>
      ) : null}
    </Panel>
  );
}

function UpcomingPlanPanel(props: { readonly panel: PlanPanel }): ReactElement {
  if (props.panel.kind === "unknown") {
    return (
      <Panel name="plan" title="Plan">
        <Unknown reason={props.panel.reason} />
      </Panel>
    );
  }
  const dates = props.panel.items
    .slice(0, MAX_VISIBLE_PLAN_ITEMS)
    .map((item) => item.date)
    .sort();
  const oldest = dates[0];
  const newest = dates.at(-1);
  return (
    <Panel name="plan" title="Plan">
      <ol className={styles.plan}>
        {props.panel.items.slice(0, MAX_VISIBLE_PLAN_ITEMS).map((item) => (
          <li className={styles.planItem} key={item.id}>
            <strong>{item.name ?? "Cycling workout"}</strong>
            <span>
              {formatDateLabel(item.date)} · {item.workoutType}
            </span>
          </li>
        ))}
      </ol>
      {oldest === undefined || newest === undefined ? null : (
        <WorkoutArchiveExportControl oldest={oldest} newest={newest} />
      )}
    </Panel>
  );
}

function AdherenceStatePanel(props: { readonly panel: AdherencePanel }): ReactElement {
  if (props.panel.kind === "unknown") {
    return (
      <Panel name="adherence" title="Adherence">
        <Unknown reason={props.panel.reason} />
      </Panel>
    );
  }
  return (
    <Panel name="adherence" title="Adherence">
      <p className={styles.value}>{formatPercentage(props.panel.ratio)}</p>
      <p className={styles.support}>
        {props.panel.matchedDays}/{props.panel.plannedDays} planned days matched
      </p>
      <p className={styles.meta}>
        {props.panel.completedDays} completed days · As of {formatDateLabel(props.panel.asOf)}
      </p>
    </Panel>
  );
}

function WellnessPanel(props: { readonly panel: WellnessTrendPanel }): ReactElement {
  if (props.panel.kind === "unknown") {
    return (
      <Panel name="wellness" title="Wellness trend">
        <Unknown reason={props.panel.reason} />
      </Panel>
    );
  }
  return (
    <Panel name="wellness" title="Wellness trend">
      <p className={styles.meta}>As of {formatDateLabel(props.panel.asOf)} · 7 mornings</p>
      <div className={styles.wellness}>
        {props.panel.series.map((series, index) => {
          const latest = series.points.at(-1);
          return (
            <div className={styles.wellnessRow} key={series.metric}>
              <strong>{WELLNESS_LABELS[index]}</strong>
              <span className={styles.wellnessValue}>
                {latest === undefined
                  ? "No readings"
                  : series.metric === "sleep"
                    ? formatSleepDuration(latest.value)
                    : `${formatWholeNumber(latest.value)} ${series.unit}`}
              </span>
              <WellnessSparkline series={series} />
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

function RideImportPanel(): ReactElement {
  const state = useEnduragentStore((store) => store.rideImport);
  const suppressed = useEnduragentStore(rideImportStatusSuppressed);
  const actions = useEnduragentStore((store) => store.rideImportActions);
  const copy = suppressed ? "" : rideImportStatusCopy(state);
  const progress = state.status === "running" ? state.progress : null;

  return (
    <Panel name="ride-import" title="Import ride files">
      <p className={styles.support}>{RIDE_IMPORT_DESCRIPTION}</p>
      <Button
        type="button"
        variant="outline"
        className="ride-import-action mt-3"
        disabled={actions === null || state.status === "running"}
        aria-describedby="ride-import-status"
        onClick={() => {
          actions?.choose();
        }}
      >
        Import ride files
      </Button>
      {progress === null ? null : (
        <p className={styles.meta}>
          {progress.params.event.completed} of {progress.params.event.total} files processed
        </p>
      )}
      <p
        id="ride-import-status"
        className={`${styles.support} ride-import-status`}
        data-state={suppressed ? "idle" : state.status}
        role="status"
        aria-live="polite"
        aria-atomic="true"
        hidden={copy.length === 0}
      >
        {copy}
      </p>
    </Panel>
  );
}

export function TrainingView(): ReactElement {
  const training = useEnduragentStore((store) => store.training);
  const selectedRide = useEnduragentStore((store) => store.selectedRide);
  const openRide = useEnduragentStore((store) => store.openRide);
  const closeRide = useEnduragentStore((store) => store.closeRide);
  const rideAnalysis = useEnduragentStore((store) => store.rideAnalysis);
  const rideAnalysisActions = useEnduragentStore((store) => store.rideAnalysisActions);
  const rideButtons = useRef(new Map<string, HTMLButtonElement>());
  const previousRideId = useRef<string | null>(null);
  const restrictionCard = useRef<HTMLDivElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const status = trainingStatusCopy(training.status);

  useLayoutEffect(() => {
    const currentRideId = selectedRide?.id ?? null;
    const restrictionFocusRequested = takeTrainingRestrictionFocusRequest();
    if (restrictionFocusRequested) {
      (restrictionCard.current ?? title.current)?.focus();
    } else if (currentRideId !== null && previousRideId.current !== currentRideId) {
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
  }, [selectedRide?.id]);

  if (selectedRide !== null) {
    return (
      <RideDetailView
        ride={selectedRide}
        units={training.unitsPreference.value}
        analysis={rideAnalysis}
        onRefreshAnalysis={
          rideAnalysisActions === null ? null : (sections) => rideAnalysisActions.refresh(sections)
        }
        titleRef={title}
        onBack={closeRide}
      />
    );
  }

  return (
    <Page title="Training" titleRef={title} busy={training.status === "loading"}>
      <p className={`${styles.status} training-status`} hidden={training.status === "ready"}>
        {status}
      </p>
      <SyncPanel restrictionCard={restrictionCard} />
      <PowerProgressStatePanel panel={training.trainingContext.performanceProgress} />
      <RecentRidesStatePanel
        panel={training.trainingContext.recentRides}
        units={training.unitsPreference.value}
        onOpen={(ride: RecentRide) => {
          openRide(ride);
        }}
        registerButton={(id, node) => {
          if (node === null) rideButtons.current.delete(id);
          else rideButtons.current.set(id, node);
        }}
      />
      <AnchorPanel panel={training.trainingContext.anchorZones} />
      <LoadPanel panel={training.trainingContext.cyclingLoad} />
      <UpcomingPlanPanel panel={training.trainingContext.plan} />
      <AdherenceStatePanel panel={training.trainingContext.adherence} />
      <WellnessPanel panel={training.trainingContext.wellnessTrend} />
      <RideImportPanel />
    </Page>
  );
}
