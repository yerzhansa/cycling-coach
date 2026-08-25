import type { ReactElement } from "react";
import { Button } from "../../components/ui/button.js";
import { useEnduragentStore } from "../../state/store.js";
import { formatDateLabel, formatWholeNumber } from "../../training-context/format.js";

function ContextSection(props: {
  readonly label: string;
  readonly title: string;
  readonly detail?: string;
}): ReactElement {
  return (
    <section className="border-t border-line py-row first:border-t-0 first:pt-0">
      <h3 className="m-0 text-xs font-semibold tracking-[0.06em] text-ink-2 uppercase">
        {props.label}
      </h3>
      <p className="mt-[calc(var(--inset)/2)] mb-0 text-sm font-semibold text-ink">{props.title}</p>
      {props.detail === undefined ? null : (
        <p className="mt-[calc(var(--inset)/2)] mb-0 text-xs text-ink-2">{props.detail}</p>
      )}
    </section>
  );
}

function unavailableCopy(reason: string): string {
  return reason === "no-plan" || reason === "no-platform-load" || reason === "missing-anchor"
    ? "Not available yet"
    : "Waiting for training data";
}

export function TrainingContextPanel(props: {
  readonly titleId?: string;
  readonly labelledBy?: string;
  readonly className?: string;
}): ReactElement {
  const training = useEnduragentStore((state) => state.training);
  const setActiveView = useEnduragentStore((state) => state.setActiveView);
  const context = training.trainingContext;
  const nextWorkout = context.plan.kind === "computed" ? context.plan.items[0] : undefined;
  const upcomingCount = context.plan.kind === "computed" ? context.plan.items.length : 0;

  return (
    <aside
      className={`training-context min-h-0 overflow-auto border-l border-line bg-surface-2 px-[calc(var(--inset)*2)] py-[calc(var(--inset)*2)] ${props.className ?? ""}`}
      aria-label={props.labelledBy === undefined ? "Training context" : undefined}
      aria-labelledby={props.labelledBy}
    >
      <h2 id={props.titleId} className="m-0 text-sm font-semibold">
        Training context
      </h2>
      <p className="mt-[calc(var(--inset)/2)] mb-[calc(var(--inset)*2)] text-xs text-ink-2">
        Available to Coach
      </p>

      {training.status === "loading" ? (
        <p className="m-0 text-sm text-ink-2" role="status">
          Loading training context…
        </p>
      ) : training.status === "unavailable" ? (
        <p className="m-0 text-sm text-ink-2" role="status">
          Training context is temporarily unavailable.
        </p>
      ) : (
        <div>
          {nextWorkout === undefined ? (
            <ContextSection
              label="Next workout"
              title={
                context.plan.kind === "unknown"
                  ? unavailableCopy(context.plan.reason)
                  : "No upcoming workouts"
              }
            />
          ) : (
            <ContextSection
              label="Next workout"
              title={nextWorkout.name ?? "Cycling workout"}
              detail={`${formatDateLabel(nextWorkout.date)} · ${nextWorkout.workoutType}`}
            />
          )}

          <ContextSection
            label="Upcoming plan"
            title={
              context.plan.kind === "computed"
                ? `${upcomingCount} scheduled ${upcomingCount === 1 ? "workout" : "workouts"}`
                : unavailableCopy(context.plan.reason)
            }
            detail={
              context.plan.kind === "computed" && context.plan.items.length > 1
                ? context.plan.items
                    .slice(1, 3)
                    .map((item) => item.name ?? item.workoutType)
                    .join(" · ")
                : undefined
            }
          />

          <ContextSection
            label="Recent load"
            title={
              context.cyclingLoad.kind === "computed"
                ? formatWholeNumber(context.cyclingLoad.value)
                : unavailableCopy(context.cyclingLoad.reason)
            }
            detail={
              context.cyclingLoad.kind === "computed"
                ? `${context.cyclingLoad.activityCount} cycling activities · 7 days`
                : undefined
            }
          />

          <ContextSection
            label="Cycling anchor"
            title={
              context.anchorZones.kind === "computed"
                ? `${formatWholeNumber(context.anchorZones.anchor.watts)} W`
                : unavailableCopy(context.anchorZones.reason)
            }
            detail={
              context.anchorZones.kind === "computed"
                ? `${context.anchorZones.anchor.source} · ${context.anchorZones.anchor.confidence}`
                : undefined
            }
          />
        </div>
      )}

      {training.status === "refresh-unavailable" ? (
        <p className="mt-[calc(var(--inset)/2)] mb-0 text-xs text-warn" role="status">
          Showing saved context; refresh is unavailable.
        </p>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="mt-inset -ml-inset text-ink-2"
        onClick={() => {
          setActiveView("training");
        }}
      >
        Open Training
      </Button>
    </aside>
  );
}
