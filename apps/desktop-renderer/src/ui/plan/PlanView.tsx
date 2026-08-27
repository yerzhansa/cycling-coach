import {
  Activity,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  History,
  LoaderCircle,
  MapPinned,
  RefreshCw,
  TriangleAlert,
  Undo2,
} from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type ReactElement } from "react";
import {
  PLAN_MIN_FULL_DAYS,
  PlanActiveProjectionDataSchema,
  PlanCoachProjectionDataSchema,
  type PlanDraftPlanProjection,
  type PlanFtpProjection,
  type PlanFtpSourceValue,
  type PlanHistoryEntry,
  type PlanRaceCourseProjection,
  type PlanRaceCourseSummary,
  type PlanStartDateProjection,
} from "@enduragent/coach-contract";
import { Button } from "../../components/ui/button.js";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog.js";
import { planReadModel } from "../../state/plan-slice.js";
import { useEnduragentStore } from "../../state/store.js";
import { CoachDecisionPanel } from "../chat/CoachDecisionPanel.js";
import { Composer, type ComposerHandle } from "../chat/Composer.js";
import { ConversationTranscript } from "../chat/Transcript.js";
import { Page } from "../shared/Page.js";

const SUPPORT_PAIR = "grid gap-[calc(var(--inset)/2)]";
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

function civilDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function civilText(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function addCivilDate(value: string, days: number): string {
  const date = civilDate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return civilText(date);
}

function civilDays(start: string, end: string): number {
  return Math.round((civilDate(end).getTime() - civilDate(start).getTime()) / 86_400_000) + 1;
}

function weekdayIndex(value: string): number {
  return civilDate(value).getUTCDay();
}

function formatCivilDate(value: string, options?: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: "UTC",
    dateStyle: options === undefined ? "medium" : undefined,
    ...options,
  }).format(civilDate(value));
}

function plannedTime(durationS: number): string {
  const hours = Math.floor(durationS / 3_600);
  const minutes = Math.round((durationS % 3_600) / 60);
  if (hours === 0) return `${minutes} min`;
  return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`;
}

function historyDuration(durationS: number | null): string {
  if (durationS === null) return "—";
  const hours = Math.floor(durationS / 3_600);
  const minutes = Math.floor((durationS % 3_600) / 60);
  return `${hours}:${String(minutes).padStart(2, "0")}`;
}

function historyReason(entry: PlanHistoryEntry): string | null {
  if (entry.undoStatus === "eligible") {
    return "Undo is available while this is the newest change and its Workout is future and coach-owned.";
  }
  if (entry.undoStatus === "undone") return "Undone; this entry remains in History.";
  if (entry.undoStatus !== "expired") return null;
  if (entry.undoReason === "newer-change") return "A newer change was applied.";
  if (entry.undoReason === "workout-not-future") return "The Workout is no longer in the future.";
  if (entry.undoReason === "workout-not-coach-owned")
    return "The Workout is no longer coach-owned.";
  if (entry.undoReason === "workout-changed") return "The Workout changed after this entry.";
  if (entry.undoReason === "plan-not-active") return "The Plan is no longer active.";
  if (entry.undoReason === "workout-missing") return "The Workout is no longer in this Plan.";
  return "Undo is no longer available.";
}

function historyDetail(entry: PlanHistoryEntry): string {
  if (entry.before === null || entry.after === null) return "Approved locally";
  const workout = `${entry.before.name} · ${historyDuration(entry.before.durationS)} → ${entry.after.name} · ${historyDuration(entry.after.durationS)}`;
  return entry.weekLoadBefore === null || entry.weekLoadAfter === null
    ? workout
    : `${workout} · Week load ${entry.weekLoadBefore} → ${entry.weekLoadAfter}`;
}

function PlanHistoryProjection(props: {
  readonly entries: readonly PlanHistoryEntry[];
}): ReactElement {
  const actions = useEnduragentStore((state) => state.planActions);
  return (
    <section className="grid gap-row rounded-card bg-surface p-5 shadow-elev-1">
      <div className="flex items-start justify-between gap-row">
        <div className={SUPPORT_PAIR}>
          <h2
            id="plan-history-heading"
            tabIndex={-1}
            className="m-0 text-lg font-semibold outline-none"
          >
            Plan history
          </h2>
          <p className="m-0 text-ink-2">Plan changes are saved here and cannot be edited.</p>
        </div>
        <Button type="button" variant="outline" onClick={() => actions?.closeHistory()}>
          Back to Plan
        </Button>
      </div>
      <div className="relative grid pl-8">
        <span className="absolute bottom-4 left-[7px] top-4 w-px bg-line" aria-hidden="true" />
        {props.entries.map((entry) => (
          <article
            key={entry.id}
            className="relative grid gap-[calc(var(--inset)/2)] border-b border-line py-row last:border-b-0"
          >
            <span
              className="absolute -left-8 top-[calc(var(--row-inset)+2px)] size-[15px] rounded-full border-[4px] border-surface bg-primary"
              aria-hidden="true"
            />
            <div className="flex items-start justify-between gap-row">
              <div className={SUPPORT_PAIR}>
                <h3 className="m-0 text-base font-semibold">{entry.label}</h3>
                <p className="m-0 text-sm text-ink-2">
                  {new Intl.DateTimeFormat(undefined, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  }).format(new Date(entry.occurredAtMs))}
                  {" · "}
                  {historyDetail(entry)}
                </p>
              </div>
              {entry.undoStatus === "eligible" ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => actions?.undoPlanChange(entry.id)}
                >
                  <Undo2 className="size-4" aria-hidden="true" />
                  Undo
                </Button>
              ) : null}
            </div>
            {historyReason(entry) === null ? null : (
              <p className="m-0 text-sm text-ink-2">{historyReason(entry)}</p>
            )}
          </article>
        ))}
      </div>
      <div className="flex flex-col gap-inset border-t border-line pt-row sm:flex-row sm:items-center sm:justify-between">
        <p className="m-0 text-sm text-ink-2">
          Auto-apply and Weekly review change future behavior; History remains unchanged.
        </p>
        <Button
          id="plan-settings-trigger"
          type="button"
          variant="outline"
          onClick={() => actions?.openPlanSettings()}
        >
          Open settings
        </Button>
      </div>
    </section>
  );
}

function PlanSettingsProjection(props: {
  readonly data: ReturnType<typeof PlanActiveProjectionDataSchema.parse>;
  readonly scenarioId: string;
}): ReactElement {
  const actions = useEnduragentStore((state) => state.planActions);
  const transition = useEnduragentStore((state) => state.plan.transition);
  const pending = useEnduragentStore((state) => state.plan.settingPending);
  const settings = props.data.settings;
  if (settings === undefined) {
    return <StatusCard title="Plan settings" support="Refreshing Plan settings…" />;
  }
  const saving =
    (transition.status === "submitting" || transition.status === "running") &&
    transition.transitionId === "PL-T22";
  const row = (
    setting: "auto-apply" | "weekly-review",
    title: string,
    support: string,
    persisted: boolean,
  ): ReactElement => {
    const active = pending?.setting === setting || settings.selectedSetting === setting;
    const value = saving && pending?.setting === setting ? pending.value : persisted;
    const failed = active && props.scenarioId === "PL-S093";
    const saved = active && props.scenarioId === "PL-S092";
    return (
      <div className="flex min-h-[76px] items-center justify-between gap-row px-5 py-4">
        <div className={SUPPORT_PAIR}>
          <h3 className="m-0 text-base font-medium">{title}</h3>
          <p className="m-0 text-sm text-ink-2">{support}</p>
          {active ? (
            <p
              className={`m-0 text-sm ${failed ? "text-danger" : saved ? "text-ok" : "text-ink-2"}`}
              aria-live="polite"
            >
              {saving ? "Saving…" : failed ? "Couldn’t save · previous value restored" : "Saved"}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-inset">
          {failed ? (
            <Button type="button" variant="ghost" onClick={() => actions?.retry()}>
              Retry
            </Button>
          ) : null}
          <button
            type="button"
            role="switch"
            aria-checked={value}
            aria-label={title}
            disabled={actions === null || saving}
            className={`relative h-7 w-12 rounded-full border-0 p-0 transition-colors ${
              value ? "bg-primary" : "bg-line-2"
            } disabled:cursor-wait disabled:opacity-70`}
            onClick={() => actions?.setPlanSetting(setting, !persisted)}
          >
            <span
              className={`absolute top-1 size-5 rounded-full bg-surface shadow-elev-1 transition-[left] ${
                value ? "left-6" : "left-1"
              }`}
              aria-hidden="true"
            />
          </button>
        </div>
      </div>
    );
  };
  return (
    <section className="grid rounded-card bg-surface shadow-elev-1">
      <div className="flex items-start justify-between gap-row p-5 pb-row">
        <div className={SUPPORT_PAIR}>
          <h2
            id="plan-settings-heading"
            tabIndex={-1}
            className="m-0 text-lg font-semibold outline-none"
          >
            Plan settings
          </h2>
          <p className="m-0 text-ink-2">{props.data.plan.name} · changes save immediately</p>
        </div>
        <Button type="button" variant="outline" onClick={() => actions?.closePlanSettings()}>
          Back to history
        </Button>
      </div>
      <div className="divide-y divide-line border-t border-line">
        {row(
          "auto-apply",
          "Auto-apply",
          "Apply eligible coach changes without approval.",
          settings.autoApply,
        )}
        {row(
          "weekly-review",
          "Weekly review",
          "Prepare one review each week.",
          settings.weeklyReview,
        )}
      </div>
    </section>
  );
}

function HistoryResultProjection(props: {
  readonly scenarioId: string;
  readonly entry: PlanHistoryEntry | null;
}): ReactElement {
  const actions = useEnduragentStore((state) => state.planActions);
  if (props.scenarioId === "PL-S026") {
    return (
      <section className="grid gap-row rounded-card bg-surface p-5 shadow-elev-1">
        <div className="flex items-start gap-row">
          <History className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden="true" />
          <div className={SUPPORT_PAIR}>
            <h2
              id="plan-history-result-heading"
              tabIndex={-1}
              className="m-0 text-lg font-semibold outline-none"
            >
              Undo expired
            </h2>
            <p className="m-0 text-ink-2">
              {props.entry === null
                ? "This change remains in History but can no longer be undone."
                : (historyReason(props.entry) ??
                  "This change remains in History but can no longer be undone.")}
            </p>
          </div>
        </div>
        <div className="flex justify-end">
          <Button type="button" onClick={() => actions?.openHistory()}>
            Back to history
          </Button>
        </div>
      </section>
    );
  }
  return (
    <section className="grid gap-row rounded-card bg-surface p-5 shadow-elev-1">
      <div className="flex items-start gap-row">
        <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-ok" aria-hidden="true" />
        <div className={SUPPORT_PAIR}>
          <h2
            id="plan-history-result-heading"
            tabIndex={-1}
            className="m-0 text-lg font-semibold outline-none"
          >
            Plan change undone
          </h2>
          <p className="m-0 text-ink-2">
            {props.entry?.after === null || props.entry?.after === undefined
              ? "The previous Workout values are restored."
              : `${props.entry.after.name} · ${historyDuration(props.entry.after.durationS)} is restored. The seven-day Intervals window will reconcile next.`}
          </p>
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={() => actions?.openHistory()}>
          View history
        </Button>
        <Button type="button" onClick={() => actions?.closeHistory()}>
          Back to Plan
        </Button>
      </div>
    </section>
  );
}

function AppliedHistoryProjection(props: {
  readonly entry: PlanHistoryEntry | null;
  readonly autoApplied?: boolean;
}): ReactElement {
  const actions = useEnduragentStore((state) => state.planActions);
  const before = props.entry?.before ?? null;
  const after = props.entry?.after ?? null;
  return (
    <section className="grid gap-row rounded-card bg-surface p-5 shadow-elev-1">
      <div className="flex items-start gap-row">
        <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-ok" aria-hidden="true" />
        <div className={SUPPORT_PAIR}>
          <h2
            id="plan-history-result-heading"
            tabIndex={-1}
            className="m-0 text-lg font-semibold outline-none"
          >
            {props.autoApplied
              ? after === null
                ? "Plan updated"
                : `${after.name} applied automatically`
              : after === null
                ? "Plan updated"
                : `${after.name} is now active`}
          </h2>
          <p className="m-0 text-ink-2">
            {props.autoApplied
              ? "Auto-apply reduced one future Workout after every safety rule passed. The seven-day Intervals update has not started yet."
              : "The approved change is part of your Plan. The seven-day Intervals update has not started yet."}
          </p>
        </div>
      </div>
      {before === null || after === null ? null : (
        <div className="grid gap-inset rounded-card bg-sunk p-row sm:grid-cols-2">
          <div className={SUPPORT_PAIR}>
            <p className="m-0 text-sm text-ink-2">Before</p>
            <p className="m-0 font-semibold">
              {before.name} · {historyDuration(before.durationS)}
            </p>
          </div>
          <div className={SUPPORT_PAIR}>
            <p className="m-0 text-sm text-ink-2">After</p>
            <p className="m-0 font-semibold">
              {after.name} · {historyDuration(after.durationS)}
            </p>
          </div>
        </div>
      )}
      {props.entry === null ||
      props.entry.weekLoadBefore === null ||
      props.entry.weekLoadAfter === null ? null : (
        <div className="flex items-center justify-between gap-inset">
          <span className="text-sm text-ink-2">Week load change</span>
          <strong>
            {props.entry.weekLoadAfter - props.entry.weekLoadBefore < 0 ? "−" : "+"}
            {Math.abs(props.entry.weekLoadAfter - props.entry.weekLoadBefore)}
          </strong>
        </div>
      )}
      {props.entry?.undoStatus === "eligible" ? (
        <div className="flex flex-col gap-inset sm:flex-row sm:items-center sm:justify-between">
          <p className="m-0 text-sm text-ink-2">
            Undo is available while this is the newest change and its Workout is future and
            coach-owned.
          </p>
          <span className="self-start rounded-full bg-sunk px-3 py-1 text-sm text-ink-2">
            Eligible
          </span>
        </div>
      ) : null}
      <div className="flex flex-wrap justify-end gap-inset">
        {props.entry?.undoStatus === "eligible" ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => actions?.undoPlanChange(props.entry!.id)}
          >
            <Undo2 className="size-4" aria-hidden="true" />
            Undo
          </Button>
        ) : null}
        <Button type="button" onClick={() => actions?.closeHistory()}>
          Back to Plan
        </Button>
      </div>
    </section>
  );
}

const MATCH_STATUS_COPY = {
  "as-planned": "As planned",
  adjusted: "Adjusted",
  moved: "Moved",
  missed: "Missed",
  extra: "Extra",
  "decision-needed": "Decision needed",
  "awaiting-sync": "Awaiting sync",
  upcoming: "Planned",
} as const;

function matchStatusClass(status: keyof typeof MATCH_STATUS_COPY): string {
  if (status === "as-planned") return "text-ok";
  if (status === "adjusted" || status === "decision-needed") return "text-warn";
  if (status === "missed") return "text-danger";
  return "text-ink-2";
}

function RetryButton(): ReactElement | null {
  const actions = useEnduragentStore((state) => state.planActions);
  if (actions === null) return null;
  return (
    <Button type="button" variant="outline" onClick={() => actions.retry()}>
      Retry
    </Button>
  );
}

function StatusCard(props: {
  readonly title: string;
  readonly support: string;
  readonly retry?: boolean;
}): ReactElement {
  return (
    <section className="grid gap-row rounded-card bg-surface p-5 shadow-elev-1">
      <div className={SUPPORT_PAIR}>
        <h2 className="m-0 text-base font-medium">{props.title}</h2>
        <p className="m-0 text-ink-2">{props.support}</p>
      </div>
      {props.retry === true ? (
        <div className="pt-row">
          <RetryButton />
        </div>
      ) : null}
    </section>
  );
}

function StaleNotice(props: { readonly message: string }): ReactElement {
  return (
    <div
      className="flex items-start gap-row rounded-ctl bg-[color-mix(in_srgb,var(--warn)_10%,var(--surface))] p-3 text-warn"
      role="status"
    >
      <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <p className="m-0 text-ink-2">{props.message}</p>
    </div>
  );
}

function courseSummaryCopy(course: PlanRaceCourseSummary): string {
  const distance = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(
    course.distanceM / 1_000,
  );
  const elevation =
    course.elevationGainM === null
      ? "Elevation unavailable"
      : `${Math.round(course.elevationGainM).toLocaleString()} m climbing`;
  return `${distance} km · ${elevation}`;
}

function CourseActions(props: {
  readonly replace?: boolean;
  readonly routeOnly?: boolean;
  readonly retry?: boolean;
  readonly continueWithout?: boolean;
  readonly remove?: boolean;
}): ReactElement {
  const actions = useEnduragentStore((state) => state.planActions);
  const transition = useEnduragentStore((state) => state.plan.transition);
  const busy = transition.status === "submitting" || transition.status === "running";
  return (
    <div className="flex flex-wrap justify-end gap-inset pt-inset">
      {props.replace === true ? (
        <Button
          type="button"
          variant="outline"
          disabled={actions === null || busy}
          onClick={() => actions?.openCoursePicker()}
        >
          Replace file
        </Button>
      ) : null}
      {props.routeOnly === true ? (
        <Button
          type="button"
          variant="outline"
          disabled={actions === null || busy}
          onClick={() => actions?.useCourseWithoutElevation()}
        >
          Use route only
        </Button>
      ) : null}
      {props.retry === true ? (
        <Button
          type="button"
          variant="outline"
          disabled={actions === null || busy}
          onClick={() => actions?.retry()}
        >
          Retry
        </Button>
      ) : null}
      {props.continueWithout === true ? (
        <Button
          type="button"
          disabled={actions === null || busy}
          onClick={() => actions?.continueWithoutCourse()}
        >
          Continue without course
        </Button>
      ) : null}
      {props.remove === true ? (
        <Button
          type="button"
          variant="outline"
          disabled={actions === null || busy}
          onClick={() => actions?.removeCourse()}
        >
          Continue without course
        </Button>
      ) : null}
    </div>
  );
}

function RaceCoursePanel(props: {
  readonly course: PlanRaceCourseProjection;
  readonly draft: boolean;
}): ReactElement {
  const actions = useEnduragentStore((state) => state.planActions);
  const transition = useEnduragentStore((state) => state.plan.transition);
  const busy =
    (transition.status === "submitting" || transition.status === "running") &&
    (transition.transitionId === "PL-T02" || transition.transitionId === "PL-T09");
  if (busy) {
    const recalculating = props.draft && transition.transitionId === "PL-T09";
    return (
      <section className="flex items-start gap-row rounded-card bg-sunk p-4" aria-live="polite">
        <LoaderCircle
          className="mt-0.5 size-4 shrink-0 animate-spin text-primary motion-reduce:animate-none"
          aria-hidden="true"
        />
        <div className={SUPPORT_PAIR}>
          <h3 className="m-0 text-sm font-medium">
            {recalculating ? "Recalculating Draft" : "Reading Race Course"}
          </h3>
          <p className="m-0 text-ink-2">
            {recalculating
              ? "Your previous Draft stays available until this update is complete."
              : "Checking route shape, distance, and elevation."}
          </p>
        </div>
      </section>
    );
  }
  const course = props.course;
  if (course.status === "ready" && course.accepted !== null) {
    return (
      <section className="grid gap-row rounded-card bg-sunk p-4">
        <div className="flex items-start gap-row">
          <MapPinned className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
          <div className={`${SUPPORT_PAIR} min-w-0 flex-1`}>
            <h3 className="m-0 text-sm font-medium">{course.accepted.fileName}</h3>
            <p className="m-0 text-ink-2">{courseSummaryCopy(course.accepted)}</p>
          </div>
        </div>
        <div className="flex flex-wrap justify-end gap-inset pt-inset">
          <Button type="button" variant="outline" onClick={() => actions?.openCoursePicker()}>
            Replace file
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              props.draft ? actions?.removeCourse() : actions?.continueWithoutCourse()
            }
          >
            Continue without course
          </Button>
        </div>
      </section>
    );
  }
  if (course.status === "invalid") {
    return (
      <section className="grid gap-row rounded-card bg-sunk p-4" role="alert">
        <div className="flex items-start gap-row">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden="true" />
          <div className={SUPPORT_PAIR}>
            <h3 className="m-0 text-sm font-medium">This file can’t be read</h3>
            <p className="m-0 text-ink-2">{course.detail}</p>
          </div>
        </div>
        <CourseActions replace continueWithout />
      </section>
    );
  }
  if (course.status === "missing-elevation" && course.candidate !== null) {
    return (
      <section className="grid gap-row rounded-card bg-sunk p-4" role="status">
        <div className="flex items-start gap-row">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden="true" />
          <div className={SUPPORT_PAIR}>
            <h3 className="m-0 text-sm font-medium">Route found, elevation missing</h3>
            <p className="m-0 text-ink-2">{courseSummaryCopy(course.candidate)}</p>
          </div>
        </div>
        <CourseActions replace routeOnly continueWithout />
      </section>
    );
  }
  if (course.status === "recalculation-failed") {
    return (
      <section className="grid gap-row rounded-card bg-sunk p-4" role="alert">
        <div className="flex items-start gap-row">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden="true" />
          <div className={SUPPORT_PAIR}>
            <h3 className="m-0 text-sm font-medium">Draft recalculation failed</h3>
            <p className="m-0 text-ink-2">Your previous Draft is unchanged.</p>
          </div>
        </div>
        <CourseActions retry replace continueWithout />
      </section>
    );
  }
  if (course.status === "omission-failed") {
    return (
      <section className="grid gap-row rounded-card bg-sunk p-4" role="alert">
        <div className="flex items-start gap-row">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden="true" />
          <div className={SUPPORT_PAIR}>
            <h3 className="m-0 text-sm font-medium">Couldn’t continue without a Race Course</h3>
            <p className="m-0 text-ink-2">Nothing changed.</p>
          </div>
        </div>
        <div className="flex justify-end gap-inset pt-inset">
          <Button type="button" variant="outline" onClick={() => actions?.returnToCoach()}>
            Back to coach
          </Button>
          <Button type="button" onClick={() => actions?.retry()}>
            Retry
          </Button>
        </div>
      </section>
    );
  }
  return (
    <section className="grid gap-row rounded-card bg-sunk p-4">
      <div className={SUPPORT_PAIR}>
        <h3 className="m-0 text-sm font-medium">Race Course · optional</h3>
        <p className="m-0 text-ink-2">
          {course.status === "omitted"
            ? "This Draft stays course-agnostic."
            : "Add a GPX or FIT file, or continue without one."}
        </p>
      </div>
      <div className="flex flex-wrap justify-end gap-inset pt-inset">
        <Button type="button" variant="outline" onClick={() => actions?.openCoursePicker()}>
          {course.status === "omitted" ? "Add file" : "Attach GPX/FIT"}
        </Button>
        {course.status === "undecided" ? (
          <Button type="button" onClick={() => actions?.continueWithoutCourse()}>
            Continue without course
          </Button>
        ) : null}
      </div>
    </section>
  );
}

function CoursePickerDialog(): ReactElement {
  const open = useEnduragentStore((state) => state.plan.coursePicker);
  const actions = useEnduragentStore((state) => state.planActions);
  const cancel = useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) actions?.closeCoursePicker();
      }}
    >
      <DialogContent
        className="w-[min(520px,calc(100vw-32px))] max-w-none gap-0 p-6 shadow-elev-4 sm:max-w-none"
        showCloseButton={false}
        initialFocus={cancel}
      >
        <DialogHeader className="gap-2.5">
          <DialogTitle className="m-0 text-xl">Add Race Course</DialogTitle>
          <DialogDescription className="m-0 leading-[1.5]">
            Choose a GPX or FIT file. Your Draft stays here while it is checked.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="mx-0 mt-[22px] mb-0 flex-row justify-end border-0 bg-transparent p-0">
          <DialogClose render={<Button ref={cancel} variant="outline" size="lg" />}>
            Cancel
          </DialogClose>
          <Button type="button" size="lg" onClick={() => actions?.chooseCourseFile()}>
            Choose file
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NoPlan(): ReactElement {
  const actions = useEnduragentStore((state) => state.planActions);
  const transition = useEnduragentStore((state) => state.plan.transition);
  const model = useEnduragentStore((state) => planReadModel(state.plan));
  const startGuard = model?.transitions.find((guard) => guard.transitionId === "PL-T01");
  const startBlocked = startGuard?.status === "blocked";
  const busy = transition.status === "submitting" || transition.status === "running";
  const failed = transition.status === "failed";

  return (
    <div className="grid gap-6" data-plan-scenario="PL-S001">
      <section className={SUPPORT_PAIR}>
        <h2 className="m-0 text-lg font-semibold">Train toward one clear goal</h2>
        <p className="m-0 text-ink-2">
          Your coach will ask here for your Goal Event, optional GPX/FIT Race Course, weekly
          availability, and FTP. Nothing writes until you approve.
        </p>
      </section>
      <section className="grid gap-inset">
        <h2 className="m-0 text-sm font-medium">What the draft needs</h2>
        <div className="overflow-hidden rounded-card bg-surface px-5 shadow-elev-1">
          <div className={`${SUPPORT_PAIR} py-3.5`}>
            <h3 className="m-0 text-sm font-medium">Goal event + Race Course</h3>
            <p className="m-0 text-ink-2">Race date, priority, and optional GPX/FIT file</p>
          </div>
          <div className="h-px bg-line" />
          <div className={`${SUPPORT_PAIR} py-3.5`}>
            <h3 className="m-0 text-sm font-medium">Current training</h3>
            <p className="m-0 text-ink-2">Recent workouts, recovery, and weekly availability</p>
          </div>
          <div className="h-px bg-line" />
          <div className={`${SUPPORT_PAIR} py-3.5`}>
            <h3 className="m-0 text-sm font-medium">FTP</h3>
            <p className="m-0 text-ink-2">Athlete-entered FTP, Intervals FTP, or Intervals eFTP</p>
          </div>
        </div>
      </section>
      {failed ? <StaleNotice message={transition.error.message} /> : null}
      {startBlocked && startGuard.reason !== null ? (
        <StaleNotice message={startGuard.reason} />
      ) : null}
      <div className="flex flex-wrap gap-inset">
        <Button
          type="button"
          disabled={actions === null || busy || startBlocked}
          aria-busy={busy ? "true" : undefined}
          onClick={() => actions?.startPlan()}
        >
          {busy ? "Opening coach…" : "Build a plan with coach"}
        </Button>
        {failed ? <RetryButton /> : null}
      </div>
    </div>
  );
}

function PlanQueue(): ReactElement | null {
  const queue = useEnduragentStore((state) => state.plan.coach.queued);
  const retry = useEnduragentStore((state) => state.plan.coach.retryRequired);
  const actions = useEnduragentStore((state) => state.planActions);
  if (queue.length === 0) return null;
  return (
    <section className="overflow-hidden rounded-card bg-sunk" aria-label="Queued coach messages">
      <div className="flex min-h-ctl items-center justify-between px-ctl-px">
        <h3 className="m-0 text-xs font-semibold">Queued messages</h3>
        <span className="rounded-chip bg-surface px-inset text-xs text-ink-2">{queue.length}</span>
      </div>
      {retry === null ? null : (
        <div className="border-t border-line px-ctl-px py-inset">
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={actions === null}
            onClick={() => actions?.retryQueuedCoachTurn(retry.claimId)}
          >
            Retry interrupted message
          </Button>
        </div>
      )}
      <ul className="m-0 list-none divide-y divide-line border-t border-line p-0">
        {queue.map((message, index) => (
          <li key={message.id} className="flex min-h-ctl items-center gap-inset px-ctl-px py-inset">
            <span className="min-w-0 flex-1 break-words text-sm text-ink-2">{message.text}</span>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              aria-label={`Remove queued message ${index + 1}`}
              disabled={actions === null || retry?.queuedMessageIds.includes(message.id) === true}
              onClick={() => actions?.removeQueuedCoachMessage(message.id)}
            >
              Remove
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

const FTP_SCENARIOS = new Set([
  "PL-S003",
  "PL-S057",
  "PL-S058",
  "PL-S059",
  "PL-S060",
  "PL-S061",
  "PL-S062",
]);

function ftpSourceCopy(value: PlanFtpSourceValue | null, empty: string): string {
  if (value === null) return empty;
  const refreshed = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(value.refreshedAtMs);
  return `${value.watts} W · ${refreshed}`;
}

function FtpSourceRow(props: {
  readonly label: string;
  readonly value: PlanFtpSourceValue | null;
  readonly empty: string;
  readonly selected: boolean;
}): ReactElement {
  return (
    <div className="grid gap-1 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-inset">
      <span className="text-sm font-medium">{props.label}</span>
      <span className={props.selected ? "text-sm text-primary" : "text-sm text-ink-2"}>
        {ftpSourceCopy(props.value, props.empty)}
        {props.selected ? " · Used for this Draft" : ""}
      </span>
    </div>
  );
}

function FtpResolution(props: { readonly ftp: PlanFtpProjection }): ReactElement {
  const actions = useEnduragentStore((state) => state.planActions);
  const model = useEnduragentStore((state) => planReadModel(state.plan));
  const transition = useEnduragentStore((state) => state.plan.transition);
  const [watts, setWatts] = useState(
    props.ftp.manual === null ? "" : String(props.ftp.manual.watts),
  );
  const [validation, setValidation] = useState<string | null>(null);
  const [pending, setPending] = useState<"save" | "refresh" | null>(null);
  const busy =
    (transition.status === "submitting" || transition.status === "running") &&
    transition.transitionId === "PL-T04";
  const failure =
    transition.status === "failed" && transition.transitionId === "PL-T04"
      ? transition.error.message
      : null;
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const value = Number(watts);
    if (!/^\d{1,4}$/u.test(watts) || !Number.isSafeInteger(value) || value < 1) {
      setValidation("Enter 1–9999 whole watts.");
      return;
    }
    setValidation(null);
    setPending("save");
    actions?.saveFtp(value);
  };
  const notice =
    failure ??
    validation ??
    (model?.scenarioId === "PL-S058"
      ? "No FTP was found in Intervals. Enter watts or refresh again."
      : model?.scenarioId === "PL-S060"
        ? "Sources differ. The highest-precedence value is selected for this Draft."
        : model?.scenarioId === "PL-S062"
          ? "FTP saved. Returning to your Plan coach…"
          : null);
  const scenario = busy && pending === "refresh" ? "PL-S057" : model?.scenarioId;
  const accepted = model?.scenarioId === "PL-S062";

  return (
    <section
      className="grid gap-6 rounded-card bg-surface p-5 shadow-elev-1"
      data-plan-scenario={scenario}
    >
      <div className="flex items-start gap-row">
        {accepted ? (
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-ok" aria-hidden="true" />
        ) : (
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden="true" />
        )}
        <div className={SUPPORT_PAIR}>
          <h2 className="m-0 text-base font-semibold">
            FTP needed before we build your cycling block
          </h2>
          <p className="m-0 text-ink-2">Power targets require an FTP value.</p>
        </div>
      </div>
      <form className="flex flex-wrap items-start gap-inset" onSubmit={submit}>
        <div className={SUPPORT_PAIR}>
          <label className="sr-only" htmlFor="plan-ftp-watts">
            FTP in whole watts
          </label>
          <div className="flex items-center gap-2">
            <input
              id="plan-ftp-watts"
              className="h-ctl w-28 rounded-ctl border border-line-2 bg-sunk px-3 text-sm outline-none focus:border-ring focus:ring-3 focus:ring-ring/20"
              inputMode="numeric"
              maxLength={4}
              placeholder="e.g. 282"
              value={watts}
              disabled={busy}
              aria-invalid={validation === null ? undefined : "true"}
              aria-describedby={notice === null ? undefined : "plan-ftp-notice"}
              onChange={(event) => setWatts(event.currentTarget.value.replace(/\D/gu, ""))}
            />
            <span className="text-sm text-ink-2">W</span>
          </div>
        </div>
        <Button type="submit" disabled={actions === null || busy || watts.length === 0}>
          {busy && pending === "save" ? "Saving…" : "Save"}
        </Button>
      </form>
      {notice === null ? null : (
        <div
          id="plan-ftp-notice"
          className={`rounded-ctl p-3 text-sm ${model?.scenarioId === "PL-S062" ? "bg-[color-mix(in_srgb,var(--ok)_10%,var(--surface))] text-ok" : "bg-[color-mix(in_srgb,var(--warn)_10%,var(--surface))] text-ink"}`}
          role="status"
        >
          {notice}
        </div>
      )}
      <section aria-labelledby="plan-ftp-source-status">
        <h3 id="plan-ftp-source-status" className="m-0 text-sm font-medium">
          Source status
        </h3>
        <div className="mt-inset divide-y divide-line">
          <FtpSourceRow
            label="Athlete-entered FTP"
            value={props.ftp.manual}
            empty="Not entered"
            selected={props.ftp.usedSource === "manual"}
          />
          <FtpSourceRow
            label="Intervals FTP"
            value={props.ftp.intervalsFtp}
            empty="Not found"
            selected={props.ftp.usedSource === "intervals-ftp"}
          />
          <FtpSourceRow
            label="Intervals eFTP"
            value={props.ftp.intervalsEftp}
            empty="Not found"
            selected={props.ftp.usedSource === "intervals-eftp"}
          />
        </div>
      </section>
      <div className="flex justify-end">
        <Button
          type="button"
          variant="outline"
          disabled={actions === null || busy}
          onClick={() => {
            setPending("refresh");
            actions?.refreshFtp();
          }}
        >
          <RefreshCw
            className={busy && pending === "refresh" ? "animate-spin" : ""}
            aria-hidden="true"
          />
          {busy && pending === "refresh"
            ? "Refreshing…"
            : model?.scenarioId === "PL-S059"
              ? "Retry"
              : "Refresh Intervals"}
        </Button>
      </div>
    </section>
  );
}

function PlanCoach(): ReactElement {
  const composer = useRef<ComposerHandle>(null);
  const actions = useEnduragentStore((state) => state.planActions);
  const coach = useEnduragentStore((state) => state.plan.coach);
  const model = useEnduragentStore((state) => planReadModel(state.plan));
  const transition = useEnduragentStore((state) => state.plan.transition);
  const [customDecisionOpen, setCustomDecisionOpen] = useState(false);
  const parsed = model === null ? null : PlanCoachProjectionDataSchema.safeParse(model.data);
  const data = parsed?.success === true ? parsed.data : null;
  const busy = transition.status === "submitting" || transition.status === "running";
  const ready = data?.readyToCreateDraft === true;
  const messages =
    coach.messages.length > 0
      ? coach.messages
      : (data?.messages.map((message) => ({
          id: message.id,
          ...(message.turnId === null ? {} : { turnId: message.turnId }),
          role: message.role,
          text: message.text,
          delivery: "complete" as const,
          historical: false,
        })) ?? []);
  const decision = coach.decision ?? data?.decision ?? null;

  if (data?.ftp !== undefined && data.ftp !== null && FTP_SCENARIOS.has(model?.scenarioId ?? "")) {
    return <FtpResolution ftp={data.ftp} />;
  }

  return (
    <section
      className="grid gap-6 rounded-card bg-surface p-5 shadow-elev-1"
      data-plan-scenario={model?.scenarioId}
    >
      {model?.scenarioId === "PL-S020" ? (
        <div className="flex items-start gap-row text-ok" role="status">
          <CheckCircle2 className="mt-0.5 size-4" aria-hidden="true" />
          <div className={SUPPORT_PAIR}>
            <h2 className="m-0 text-base font-medium text-ink">Draft discarded</h2>
            <p className="m-0 text-ink-2">Your Plan conversation is still here.</p>
          </div>
        </div>
      ) : null}
      {data?.ftp?.conflict === true && data.ftp.usedWatts !== null ? (
        <div
          className="rounded-ctl bg-[color-mix(in_srgb,var(--warn)_10%,var(--surface))] p-3 text-sm"
          role="status"
        >
          Using {data.ftp.usedWatts} W from the selected FTP source. Other FTP sources differ.
        </div>
      ) : null}
      <ConversationTranscript
        messages={messages}
        timeline={coach.timeline}
        historyControls={false}
      />
      <CoachDecisionPanel
        onCustomOpenChange={setCustomDecisionOpen}
        surface={{
          decision,
          phase: coach.decisionPhase,
          answerLabel: coach.decisionAnswerLabel,
          error: coach.decisionError,
          loadError: coach.decisionLoadError,
          answer: (decisionId, answer) => actions?.answerCoachDecision(decisionId, answer),
          skip: (decisionId) => actions?.skipCoachDecision(decisionId),
          retry: () => actions?.retry(),
        }}
      />
      <PlanQueue />
      {data?.course === undefined ? null : <RaceCoursePanel course={data.course} draft={false} />}
      {ready ? (
        <section className="grid gap-row rounded-card bg-sunk p-4">
          <div className={SUPPORT_PAIR}>
            <h2 className="m-0 text-sm font-medium">Ready to create Draft</h2>
            <p className="m-0 text-ink-2">
              Goal event, availability, FTP, and course choice are ready.
            </p>
          </div>
          <div className="flex flex-wrap justify-end gap-inset pt-inset">
            <Button type="button" variant="outline" onClick={() => composer.current?.focus()}>
              Back to coach
            </Button>
            <Button
              type="button"
              disabled={actions === null || busy}
              onClick={() => actions?.createDraft()}
            >
              {data?.replacement ? "Create replacement draft" : "Create draft"}
            </Button>
          </div>
        </section>
      ) : null}
      <Composer
        handle={composer}
        hidden={customDecisionOpen}
        surface={{
          status: coach.status,
          sendDisabled: coach.sendDisabled,
          inputDisabled: coach.inputDisabled || decision?.status === "unanswered",
          placeholder: "Reply to your coach…",
          label: "Reply to your Plan coach",
          allowSlashCommands: false,
          submit: (message) => actions?.submitCoach(message) ?? Promise.resolve(false),
          stop: () => actions?.stopCoach(),
        }}
      />
    </section>
  );
}

function DraftFormation(): ReactElement {
  const transition = useEnduragentStore((state) => state.plan.transition);
  const revision = transition.status === "running" && transition.transitionId === "PL-T07";
  return (
    <section
      className="grid place-items-center gap-row rounded-card bg-surface p-8 text-center shadow-elev-1"
      aria-live="polite"
      aria-busy="true"
    >
      <LoaderCircle
        className="size-6 animate-spin text-primary motion-reduce:animate-none"
        aria-hidden="true"
      />
      <div className={SUPPORT_PAIR}>
        <h2 className="m-0 text-lg font-semibold">
          {revision ? "Updating your Draft" : "Building your Draft"}
        </h2>
        <p className="m-0 text-ink-2">
          {revision
            ? "Your previous Draft stays available until this update is complete."
            : "Your Draft opens automatically when it is ready."}
        </p>
      </div>
    </section>
  );
}

function DiscardDraftDialog(): ReactElement {
  const open = useEnduragentStore((state) => state.plan.discardConfirmation);
  const actions = useEnduragentStore((state) => state.planActions);
  const cancel = useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) actions?.closeDiscardConfirmation();
      }}
    >
      <DialogContent
        className="w-[min(460px,calc(100vw-32px))] max-w-none gap-0 p-6 shadow-elev-4 sm:max-w-none"
        showCloseButton={false}
        initialFocus={cancel}
      >
        <DialogHeader className="gap-2.5">
          <DialogTitle className="m-0 text-xl">Discard this Draft?</DialogTitle>
          <DialogDescription className="m-0 leading-[1.5]">
            Only this Draft is removed. Your Plan conversation and active Plan stay.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="mx-0 mt-[22px] mb-0 flex-row justify-end border-0 bg-transparent p-0">
          <DialogClose render={<Button ref={cancel} variant="outline" size="lg" />}>
            Cancel
          </DialogClose>
          <Button
            type="button"
            variant="destructive-solid"
            size="lg"
            onClick={() => actions?.discardDraft()}
          >
            Discard Draft
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface DatePreview {
  readonly kind: "full-plan" | "short-race-preparation";
  readonly inclusiveDays: number;
  readonly totalWeeks: number;
  readonly raceWeekday: number;
  readonly raceDayOfPlanWeek: number;
}

function localDatePreview(startDate: string, targetDate: string): DatePreview {
  const inclusiveDays = civilDays(startDate, targetDate);
  return {
    kind: inclusiveDays >= PLAN_MIN_FULL_DAYS ? "full-plan" : "short-race-preparation",
    inclusiveDays,
    totalWeeks: Math.ceil(inclusiveDays / 7),
    raceWeekday: weekdayIndex(targetDate),
    raceDayOfPlanWeek: ((inclusiveDays - 1) % 7) + 1,
  };
}

function DatePickerDialog(props: {
  readonly plan: PlanDraftPlanProjection | null;
  readonly startDate: PlanStartDateProjection | undefined;
}): ReactElement {
  const open = useEnduragentStore((state) => state.plan.datePicker);
  const actions = useEnduragentStore((state) => state.planActions);
  const cancel = useRef<HTMLButtonElement>(null);
  const initialDate = props.startDate?.selectedDate ?? props.plan?.startDate ?? "";
  const [selected, setSelected] = useState(initialDate);
  const initial = initialDate.length === 0 ? new Date() : civilDate(initialDate);
  const [visibleMonth, setVisibleMonth] = useState(() => ({
    year: initial.getUTCFullYear(),
    month: initial.getUTCMonth(),
  }));

  useEffect(() => {
    if (!open || initialDate.length === 0) return;
    const date = civilDate(initialDate);
    setSelected(initialDate);
    setVisibleMonth({ year: date.getUTCFullYear(), month: date.getUTCMonth() });
  }, [initialDate, open]);

  const today = props.startDate?.today;
  const targetDate = props.startDate?.targetDate ?? props.plan?.targetDate ?? undefined;
  const preview =
    selected.length === 0 || targetDate === undefined
      ? null
      : localDatePreview(selected, targetDate);
  const scenario =
    preview?.kind === "short-race-preparation"
      ? "PL-S044"
      : preview !== null && preview.raceWeekday !== 0
        ? "PL-S045"
        : "PL-S015";
  const first = new Date(Date.UTC(visibleMonth.year, visibleMonth.month, 1));
  const mondayOffset = (first.getUTCDay() + 6) % 7;
  const gridStart = new Date(first);
  gridStart.setUTCDate(first.getUTCDate() - mondayOffset);
  const days = Array.from({ length: 42 }, (_, index) => {
    const date = new Date(gridStart);
    date.setUTCDate(gridStart.getUTCDate() + index);
    return {
      value: civilText(date),
      label: date.getUTCDate(),
      currentMonth: date.getUTCMonth() === visibleMonth.month,
    };
  });
  const monthLabel = new Intl.DateTimeFormat(undefined, {
    timeZone: "UTC",
    month: "long",
    year: "numeric",
  }).format(first);
  const moveMonth = (offset: number): void => {
    const next = new Date(Date.UTC(visibleMonth.year, visibleMonth.month + offset, 1));
    setVisibleMonth({ year: next.getUTCFullYear(), month: next.getUTCMonth() });
  };
  const valid = (value: string): boolean =>
    today !== undefined && targetDate !== undefined && value >= today && value <= targetDate;
  const selectAndFocus = (value: string): void => {
    if (!valid(value)) return;
    setSelected(value);
    const date = civilDate(value);
    if (date.getUTCMonth() !== visibleMonth.month || date.getUTCFullYear() !== visibleMonth.year) {
      setVisibleMonth({ year: date.getUTCFullYear(), month: date.getUTCMonth() });
    }
    queueMicrotask(() => {
      document.querySelector<HTMLButtonElement>(`[data-plan-date="${value}"]`)?.focus();
    });
  };

  const primaryLabel =
    preview?.kind === "short-race-preparation"
      ? "Use short block"
      : preview !== null && preview.raceWeekday !== 0
        ? "Use this date"
        : "Recalculate Plan";

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) actions?.closeDatePicker();
      }}
    >
      <DialogContent
        className="w-[min(600px,calc(100vw-32px))] max-w-none gap-0 p-6 shadow-elev-4 sm:max-w-none"
        showCloseButton={false}
        initialFocus={cancel}
        data-plan-scenario={scenario}
      >
        <DialogHeader className="gap-2.5">
          <DialogTitle className="m-0 text-xl">Choose a start date</DialogTitle>
          <DialogDescription className="m-0 leading-[1.5]">
            Past dates are unavailable. Shorter blocks stay valid; weekly preferences keep their
            weekdays.
          </DialogDescription>
        </DialogHeader>
        <section className="mt-5" aria-label="Plan start date calendar">
          <div className="grid grid-cols-[40px_1fr_40px] items-center gap-inset">
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              aria-label="Previous month"
              onClick={() => moveMonth(-1)}
            >
              <ChevronLeft aria-hidden="true" />
            </Button>
            <h3 className="m-0 text-center text-base font-semibold">{monthLabel}</h3>
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              aria-label="Next month"
              onClick={() => moveMonth(1)}
            >
              <ChevronRight aria-hidden="true" />
            </Button>
          </div>
          <div className="mt-inset grid grid-cols-7 gap-1" aria-hidden="true">
            {WEEKDAYS.map((weekday) => (
              <span key={weekday} className="py-1 text-center text-xs text-ink-2">
                {weekday}
              </span>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-1" role="group" aria-label={monthLabel}>
            {days.map((day) => {
              const disabled = !valid(day.value);
              const active = day.value === selected;
              return (
                <button
                  key={day.value}
                  type="button"
                  data-plan-date={day.value}
                  aria-label={formatCivilDate(day.value, {
                    weekday: "long",
                    month: "long",
                    day: "numeric",
                    year: "numeric",
                  })}
                  aria-pressed={active}
                  disabled={disabled}
                  tabIndex={active ? 0 : -1}
                  className={`grid size-10 place-items-center justify-self-center rounded-ctl text-sm outline-none transition-colors focus:ring-3 focus:ring-ring/25 ${
                    active
                      ? "bg-primary text-primary-foreground"
                      : disabled
                        ? "cursor-not-allowed bg-sunk text-ink-3 opacity-55"
                        : day.currentMonth
                          ? "bg-surface text-ink shadow-[inset_0_0_0_1px_var(--line-2)] hover:bg-sunk"
                          : "bg-sunk text-ink-2 hover:text-ink"
                  }`}
                  onClick={() => selectAndFocus(day.value)}
                  onKeyDown={(event) => {
                    const offset =
                      event.key === "ArrowLeft"
                        ? -1
                        : event.key === "ArrowRight"
                          ? 1
                          : event.key === "ArrowUp"
                            ? -7
                            : event.key === "ArrowDown"
                              ? 7
                              : 0;
                    if (offset === 0) return;
                    event.preventDefault();
                    selectAndFocus(addCivilDate(day.value, offset));
                  }}
                >
                  {day.label}
                </button>
              );
            })}
          </div>
        </section>
        {preview === null || targetDate === undefined ? null : (
          <section className="mt-5 grid gap-row rounded-card bg-sunk p-4" aria-live="polite">
            <div className={SUPPORT_PAIR}>
              <h3 className="m-0 text-sm font-semibold">
                {preview.kind === "full-plan" ? "Full Plan" : "Short race-preparation block"}
              </h3>
              <p className="m-0 text-ink-2">
                {formatCivilDate(selected)} to {formatCivilDate(targetDate)} · {preview.totalWeeks}{" "}
                {preview.totalWeeks === 1 ? "week" : "weeks"} · {preview.inclusiveDays} inclusive
                days
              </p>
            </div>
            {preview.raceWeekday === 0 ? null : (
              <p className="m-0 text-sm text-ink-2">
                Race day stays {formatCivilDate(targetDate, { weekday: "long" })}; the Plan week
                follows the selected start weekday.
              </p>
            )}
          </section>
        )}
        <DialogFooter className="mx-0 mt-[22px] mb-0 flex-row justify-end border-0 bg-transparent p-0">
          <DialogClose render={<Button ref={cancel} variant="outline" size="lg" />}>
            Cancel
          </DialogClose>
          <Button
            type="button"
            size="lg"
            disabled={
              actions === null ||
              preview === null ||
              selected === props.plan?.startDate ||
              !valid(selected)
            }
            onClick={() => actions?.recalculateStartDate(selected)}
          >
            {primaryLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DraftProjection(): ReactElement {
  const actions = useEnduragentStore((state) => state.planActions);
  const model = useEnduragentStore((state) => planReadModel(state.plan));
  const transition = useEnduragentStore((state) => state.plan.transition);
  const revisionComposer = useEnduragentStore((state) => state.plan.revisionComposer);
  const [instruction, setInstruction] = useState("");
  const parsed = model === null ? null : PlanCoachProjectionDataSchema.safeParse(model.data);
  const data = parsed?.success === true ? parsed.data : null;
  const plan = data?.plan ?? null;
  const startDate = data?.startDate;
  const dateRunning = transition.status === "running" && transition.transitionId === "PL-T08";
  const retryingDate = dateRunning && model?.scenarioId === "PL-S048";
  const approving =
    (transition.status === "submitting" || transition.status === "running") &&
    transition.transitionId === "PL-T11";
  const busy = dateRunning || approving;
  const displayScenario = retryingDate ? "PL-S049" : dateRunning ? "PL-S047" : model?.scenarioId;
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (/\S/u.test(instruction)) actions?.updateDraft(instruction);
  };
  return (
    <div className="grid gap-6" data-plan-scenario={displayScenario}>
      {dateRunning ? (
        <section
          className="flex items-start gap-row rounded-card bg-surface p-5 shadow-elev-1"
          aria-live="polite"
        >
          <LoaderCircle
            className="mt-0.5 size-5 shrink-0 animate-spin text-primary motion-reduce:animate-none"
            aria-hidden="true"
          />
          <div className={SUPPORT_PAIR}>
            <h2 className="m-0 text-base font-semibold">Recalculating the Plan</h2>
            <p className="m-0 text-ink-2">
              Race day and weekly availability stay fixed. Your previous Draft remains safe.
            </p>
          </div>
        </section>
      ) : null}
      <section className="grid gap-5 rounded-card bg-surface p-5 shadow-elev-1">
        {model?.scenarioId === "PL-S031" ? (
          <div className="flex items-start gap-row text-ok" role="status">
            <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <div className={SUPPORT_PAIR}>
              <h2 className="m-0 text-sm font-semibold text-ink">Draft updated</h2>
              <p className="m-0 text-ink-2">The coach applied your requested change.</p>
            </div>
          </div>
        ) : null}
        {model?.scenarioId === "PL-S050" ? (
          <div className="flex items-start gap-row text-ok" role="status">
            <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <div className={SUPPORT_PAIR}>
              <h2 className="m-0 text-sm font-semibold text-ink">Start date updated</h2>
              <p className="m-0 text-ink-2">Review the recalculated Draft before approval.</p>
            </div>
          </div>
        ) : null}
        {model?.scenarioId === "PL-S046" || model?.scenarioId === "PL-S048" ? (
          <div
            className="grid gap-row rounded-ctl bg-[color-mix(in_srgb,var(--warn)_10%,var(--surface))] p-3"
            role="alert"
          >
            <div className="flex items-start gap-row">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden="true" />
              <div className={SUPPORT_PAIR}>
                <h2 className="m-0 text-sm font-semibold">
                  {model.scenarioId === "PL-S046"
                    ? "Choose another start date"
                    : "The Plan could not be recalculated"}
                </h2>
                <p className="m-0 text-ink-2">Your current Draft is safe.</p>
              </div>
            </div>
            <div className="flex justify-end gap-inset">
              <Button type="button" variant="outline" onClick={() => actions?.openDatePicker()}>
                Choose another date
              </Button>
              {model.scenarioId === "PL-S048" ? (
                <Button type="button" onClick={() => actions?.retry()}>
                  Retry
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
        {transition.status === "failed" && transition.transitionId === "PL-T11" ? (
          <StaleNotice message="The Plan could not be activated. Your Draft is unchanged." />
        ) : null}
        <div className="flex items-start justify-between gap-row">
          <div className={SUPPORT_PAIR}>
            <h2 className="m-0 text-lg font-semibold">
              {plan?.name ?? model?.title ?? "Draft Plan"}
            </h2>
            <p className="m-0 text-ink-2">
              {plan === null
                ? model?.summary
                : `${plan.workoutCount} workouts · ${plannedTime(plan.plannedDurationS)} · ${plan.totalWeeks} ${plan.totalWeeks === 1 ? "week" : "weeks"}`}
            </p>
            <p className="m-0 text-sm text-ink-2">Calendar not started.</p>
          </div>
          <span className="rounded-chip bg-sunk px-3 py-1 text-sm text-primary">Draft</span>
        </div>
        {data?.course !== undefined ? (
          <div className="grid gap-inset border-t border-line pt-5">
            <h3 className="m-0 text-sm font-semibold">Race Course</h3>
            <RaceCoursePanel course={data.course} draft />
          </div>
        ) : null}
        {plan !== null && startDate !== undefined ? (
          <div className="flex items-center justify-between gap-row border-t border-line pt-5">
            <div className="flex min-w-0 items-start gap-row">
              <CalendarDays className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
              <div className={SUPPORT_PAIR}>
                <h3 className="m-0 text-sm font-semibold">Start date</h3>
                <p className="m-0 text-ink-2">
                  {formatCivilDate(plan.startDate)} ·{" "}
                  {plan.kind === "full-plan" ? "Full Plan" : "Short race-preparation block"}
                </p>
              </div>
            </div>
            <Button
              type="button"
              variant="outline"
              disabled={actions === null || busy}
              onClick={() => actions?.openDatePicker()}
            >
              Change
            </Button>
          </div>
        ) : null}
        {revisionComposer ? (
          <form className="grid gap-inset border-t border-line pt-5" onSubmit={submit}>
            <label className="text-sm font-medium" htmlFor="plan-draft-revision">
              What should the coach change?
            </label>
            <textarea
              id="plan-draft-revision"
              autoFocus
              rows={4}
              className="resize-y rounded-ctl border border-line-2 bg-sunk px-3 py-2 text-sm outline-none focus:border-ring focus:ring-3 focus:ring-ring/20"
              value={instruction}
              onChange={(event) => setInstruction(event.currentTarget.value)}
            />
            <div className="flex justify-end gap-inset">
              <Button
                type="button"
                variant="outline"
                onClick={() => actions?.closeRevisionComposer()}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={!/\S/u.test(instruction)}>
                Update draft
              </Button>
            </div>
          </form>
        ) : (
          <div className="grid gap-row border-t border-line pt-5">
            <div className="flex flex-wrap items-center justify-between gap-row">
              <p className="m-0 text-sm text-ink-2">
                Approval activates the Plan, then updates today plus the next six days in Intervals.
              </p>
              <div className="flex flex-wrap justify-end gap-inset">
                <Button
                  type="button"
                  variant="outline"
                  disabled={actions === null || busy}
                  onClick={() => actions?.openRevisionComposer()}
                >
                  Back to coach
                </Button>
                <Button
                  type="button"
                  disabled={actions === null || busy}
                  aria-busy={approving ? "true" : undefined}
                  onClick={() => actions?.approveDraft()}
                >
                  {approving ? "Activating…" : "Approve Plan"}
                </Button>
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-row border-t border-line pt-5">
              <p className="m-0 text-sm text-ink-2">
                Discard removes only this Draft. Your Plan conversation stays.
              </p>
              <Button
                type="button"
                variant="destructive"
                disabled={actions === null || busy}
                onClick={() => actions?.openDiscardConfirmation()}
              >
                Discard draft
              </Button>
            </div>
          </div>
        )}
      </section>
      <DiscardDraftDialog />
      <DatePickerDialog plan={plan} startDate={startDate} />
    </div>
  );
}

function AttentionProjection(): ReactElement {
  const model = useEnduragentStore((state) => planReadModel(state.plan));
  const actions = useEnduragentStore((state) => state.planActions);
  if (model === null) return <StatusCard title="Plan attention" support="Refreshing your Plan…" />;
  return (
    <section className="grid gap-row rounded-card bg-surface p-5 shadow-elev-1">
      <div className={SUPPORT_PAIR}>
        <h2 className="m-0 text-base font-medium">Plan attention</h2>
        <p className="m-0 text-ink-2">
          {model.attention.count} {model.attention.count === 1 ? "item needs" : "items need"} your
          decision.
        </p>
      </div>
      <div className="grid divide-y divide-line">
        {model.attention.items.map((item) => (
          <button
            key={item.id}
            type="button"
            className="flex w-full items-center justify-between gap-inset bg-transparent py-3 text-left text-sm hover:text-primary"
            onClick={() => actions?.openAttention(item.id)}
          >
            <span>{item.title}</span>
            <ChevronRight className="size-4 text-ink-2" aria-hidden="true" />
          </button>
        ))}
      </div>
    </section>
  );
}

function WorkoutDriftProjection(props: {
  readonly data: ReturnType<typeof PlanActiveProjectionDataSchema.parse>;
  readonly scenarioId: string;
}): ReactElement {
  const actions = useEnduragentStore((state) => state.planActions);
  const transition = useEnduragentStore((state) => state.plan.transition);
  const selected =
    props.data.selectedWorkoutId === undefined || props.data.selectedWorkoutId === null
      ? null
      : (props.data.workouts.find((workout) => workout.id === props.data.selectedWorkoutId) ??
        null);
  if (selected === null) {
    return <StatusCard title="Workout changed in Intervals" support="Refreshing this workout…" />;
  }
  const resolving =
    (transition.status === "submitting" || transition.status === "running") &&
    (transition.transitionId === "PL-T15" || transition.transitionId === "PL-T16");
  const adopted = props.scenarioId === "PL-S034";
  const restored = props.scenarioId === "PL-S036";
  const drift = selected.drift;
  const heading = resolving
    ? transition.transitionId === "PL-T15"
      ? "Updating the Plan"
      : "Restoring Plan workout"
    : adopted
      ? "Intervals edit adopted"
      : restored
        ? "Plan workout restored"
        : `${formatCivilDate(selected.date, { weekday: "long" })} changed in Intervals`;
  const support = resolving
    ? transition.transitionId === "PL-T15"
      ? `Keeping the Intervals workout and recording the adopted edit in Plan history.`
      : `Writing the Plan workout back to Intervals and verifying the match.`
    : adopted
      ? `${selected.name} is now ${
          selected.durationS === null ? "updated" : plannedTime(selected.durationS)
        } in both the Plan and Intervals.`
      : restored
        ? `${selected.name} matches the Plan again in Intervals.`
        : "Choose which version becomes authoritative.";
  return (
    <div className="grid gap-6">
      <section className="grid gap-row rounded-card bg-surface p-5 shadow-elev-1">
        <div className="flex items-start gap-row">
          <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-ok" aria-hidden="true" />
          <div className={SUPPORT_PAIR}>
            <h2 className="m-0 text-base font-semibold">
              Plan active · week {props.data.weekIndex} of {props.data.plan.totalWeeks}
            </h2>
            <p className="m-0 text-ink-2">
              {props.data.plan.name} · starts {formatCivilDate(props.data.plan.startDate)}
            </p>
          </div>
        </div>
      </section>
      <section
        className="grid gap-row rounded-card bg-surface p-5 shadow-elev-1"
        aria-live="polite"
      >
        <div className="flex items-start gap-row">
          {resolving ? (
            <LoaderCircle
              className="mt-0.5 size-5 shrink-0 animate-spin text-primary motion-reduce:animate-none"
              aria-hidden="true"
            />
          ) : adopted || restored ? (
            <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-ok" aria-hidden="true" />
          ) : (
            <TriangleAlert className="mt-0.5 size-5 shrink-0 text-warn" aria-hidden="true" />
          )}
          <div className={SUPPORT_PAIR}>
            <h2 className="m-0 text-base font-semibold">{heading}</h2>
            <p className="m-0 text-ink-2">{support}</p>
          </div>
        </div>
        {!resolving && !adopted && !restored && drift !== undefined ? (
          <>
            <div className="grid gap-inset rounded-card bg-sunk p-row sm:grid-cols-2">
              <div className={SUPPORT_PAIR}>
                <p className="m-0 text-sm text-ink-2">Plan</p>
                <p className="m-0 font-medium">{drift.plan.name}</p>
                <p className="m-0 text-sm text-ink-2">
                  {formatCivilDate(drift.plan.date)} ·{" "}
                  {drift.plan.durationS === null
                    ? "No duration"
                    : plannedTime(drift.plan.durationS)}
                </p>
              </div>
              <div className={SUPPORT_PAIR}>
                <p className="m-0 text-sm text-ink-2">Intervals</p>
                <p className="m-0 font-medium">{drift.provider.name}</p>
                <p className="m-0 text-sm text-ink-2">
                  {formatCivilDate(drift.provider.date)} ·{" "}
                  {drift.provider.durationS === null
                    ? "No duration"
                    : plannedTime(drift.provider.durationS)}
                </p>
              </div>
            </div>
            {drift.error === null ? null : (
              <div
                className="flex items-start gap-row rounded-ctl bg-[color-mix(in_srgb,var(--danger)_8%,var(--surface))] p-3"
                role="alert"
              >
                <TriangleAlert className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden="true" />
                <p className="m-0 text-sm text-ink-2">{drift.error.message}</p>
              </div>
            )}
            <div className="flex flex-wrap justify-end gap-inset">
              <Button
                type="button"
                variant="outline"
                disabled={actions === null || resolving}
                onClick={() => actions?.resolveWorkoutDrift(selected.id, drift.eventId, "adopt")}
              >
                Adopt Intervals edit
              </Button>
              <Button
                type="button"
                disabled={actions === null || resolving}
                onClick={() => actions?.resolveWorkoutDrift(selected.id, drift.eventId, "restore")}
              >
                Restore Plan workout
              </Button>
            </div>
          </>
        ) : null}
        {!resolving && (adopted || restored) ? (
          <div className="flex justify-end">
            <Button type="button" onClick={() => actions?.closeWorkout()}>
              Back to Plan
            </Button>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function ActiveProjection(): ReactElement {
  const model = useEnduragentStore((state) => planReadModel(state.plan));
  const transition = useEnduragentStore((state) => state.plan.transition);
  const actions = useEnduragentStore((state) => state.planActions);
  const [proposalMode, setProposalMode] = useState<"proposal" | "evidence" | "edit">("proposal");
  const [revisionText, setRevisionText] = useState("");
  const evidenceTrigger = useRef<HTMLButtonElement>(null);
  const previousScenario = useRef(model?.scenarioId ?? null);
  const selectedProposalKey =
    typeof model?.data.selectedProposalId === "string" ? model.data.selectedProposalId : null;
  const failedRevisionText =
    typeof model?.data.proposalRevisionText === "string" ? model.data.proposalRevisionText : "";
  useEffect(() => {
    setProposalMode(model?.scenarioId === "PL-S022" ? "edit" : "proposal");
    setRevisionText(model?.scenarioId === "PL-S022" ? failedRevisionText : "");
  }, [failedRevisionText, model?.scenarioId, selectedProposalKey]);
  useEffect(() => {
    const current = model?.scenarioId ?? null;
    const previous = previousScenario.current;
    previousScenario.current = current;
    if (current === previous || previous === null) return;
    const focusId =
      current === "PL-S004"
        ? "plan-history-trigger"
        : current === "PL-S005"
          ? "plan-history-heading"
          : current === "PL-S008" ||
              current === "PL-S026" ||
              current === "PL-S027" ||
              current === "PL-S101"
            ? "plan-history-result-heading"
            : current !== null && ["PL-S090", "PL-S091", "PL-S092", "PL-S093"].includes(current)
              ? "plan-settings-heading"
              : null;
    if (focusId === null) return;
    requestAnimationFrame(() => document.getElementById(focusId)?.focus());
  }, [model?.scenarioId]);
  if (model === null) return <StatusCard title="Plan" support="Refreshing your Plan…" />;
  const parsed = PlanActiveProjectionDataSchema.safeParse(model.data);
  if (!parsed.success) return <StatusCard title={model.title} support={model.summary} />;
  const data = parsed.data;
  const selectedHistoryEntry =
    data.selectedHistoryId === undefined || data.selectedHistoryId === null
      ? null
      : ((data.history ?? []).find((entry) => entry.id === data.selectedHistoryId) ?? null);
  if (model.scenarioId === "PL-S005") {
    return <PlanHistoryProjection entries={data.history ?? []} />;
  }
  if (model.scenarioId === "PL-S008") {
    return <AppliedHistoryProjection entry={selectedHistoryEntry} />;
  }
  if (["PL-S090", "PL-S091", "PL-S092", "PL-S093"].includes(model.scenarioId)) {
    return <PlanSettingsProjection data={data} scenarioId={model.scenarioId} />;
  }
  if (model.scenarioId === "PL-S101") {
    return <AppliedHistoryProjection entry={selectedHistoryEntry} autoApplied />;
  }
  if (model.scenarioId === "PL-S026" || model.scenarioId === "PL-S027") {
    return <HistoryResultProjection scenarioId={model.scenarioId} entry={selectedHistoryEntry} />;
  }
  const reconciling =
    (transition.status === "submitting" || transition.status === "running") &&
    transition.transitionId === "PL-T12";
  const failed = model.reconciliation.status === "failed";
  const verified = model.reconciliation.status === "verified";
  const retrying = reconciling && failed;
  const running = reconciling || model.reconciliation.status === "running";
  const completed = model.reconciliation.created;
  const total = model.reconciliation.total;
  const percent = total === 0 ? 0 : Math.round((completed / total) * 100);
  const calendarTitle = verified
    ? `Intervals · current through ${formatCivilDate(model.reconciliation.currentThrough!)}`
    : retrying
      ? "Retrying Intervals update"
      : running
        ? model.scenarioId === "PL-S042"
          ? "Resuming Intervals update"
          : "Updating Intervals"
        : failed
          ? model.scenarioId === "PL-S041"
            ? "Intervals still needs attention"
            : "Intervals update needs attention"
          : "Update Intervals for the next seven days";
  const selectedWorkout =
    data.selectedWorkoutId === undefined || data.selectedWorkoutId === null
      ? null
      : (data.workouts.find((workout) => workout.id === data.selectedWorkoutId) ?? null);
  const selectedProposal =
    data.selectedProposalId === undefined || data.selectedProposalId === null
      ? null
      : ((data.proposals ?? []).find((proposal) => proposal.id === data.selectedProposalId) ??
        null);
  const canReviseProposal = model.transitions.some(
    (guard) => guard.transitionId === "PL-T18" && guard.status === "available",
  );
  const canApproveProposal = model.transitions.some(
    (guard) => guard.transitionId === "PL-T19" && guard.status === "available",
  );
  const proposalBusy =
    (transition.status === "submitting" || transition.status === "running") &&
    (transition.transitionId === "PL-T18" || transition.transitionId === "PL-T19");
  if (["PL-S032", "PL-S033", "PL-S034", "PL-S035", "PL-S036"].includes(model.scenarioId)) {
    return <WorkoutDriftProjection data={data} scenarioId={model.scenarioId} />;
  }
  return (
    <div className="grid gap-6">
      {model.scenarioId === "PL-S097" ? (
        <section className="flex items-start gap-row rounded-card bg-surface p-5 shadow-elev-1">
          <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-ok" aria-hidden="true" />
          <div className={`min-w-0 flex-1 ${SUPPORT_PAIR}`}>
            <h2 className="m-0 text-base font-semibold">Proposal rejected</h2>
            <p className="m-0 text-ink-2">The active Plan did not change.</p>
          </div>
          <Button type="button" onClick={() => actions?.closeWorkout()}>
            Back to Plan
          </Button>
        </section>
      ) : null}
      <section className="grid gap-row rounded-card bg-surface p-5 shadow-elev-1">
        <div className="flex flex-col gap-row sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-row">
            <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-ok" aria-hidden="true" />
            <div className={SUPPORT_PAIR}>
              <h2 className="m-0 text-base font-semibold">
                Plan active · week {data.weekIndex} of {data.plan.totalWeeks}
              </h2>
              <p className="m-0 text-ink-2">
                {data.plan.name} · starts {formatCivilDate(data.plan.startDate)}
              </p>
            </div>
          </div>
          <Button
            id="plan-history-trigger"
            type="button"
            variant="outline"
            onClick={() => actions?.openHistory()}
          >
            <History className="size-4" aria-hidden="true" />
            Plan history
          </Button>
        </div>
        <div className="flex items-start gap-row border-t border-line pt-row">
          <Activity className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden="true" />
          <div className={SUPPORT_PAIR}>
            <h3 className="m-0 text-base font-semibold">
              Today · {data.todayWorkout?.name ?? "Rest"}
            </h3>
            <p className="m-0 text-ink-2">
              {data.todayWorkout?.durationS === null || data.todayWorkout === null
                ? data.todayWorkout === null
                  ? "No workout scheduled."
                  : "Follow the workout details in your Plan."
                : plannedTime(data.todayWorkout.durationS)}
            </p>
          </div>
        </div>
      </section>

      <section
        className="grid gap-row rounded-card bg-surface p-5 shadow-elev-1"
        aria-live="polite"
      >
        <div className="flex items-start gap-row">
          {failed && !retrying ? (
            <TriangleAlert className="mt-0.5 size-5 shrink-0 text-warn" aria-hidden="true" />
          ) : verified ? (
            <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-ok" aria-hidden="true" />
          ) : running ? (
            <LoaderCircle
              className="mt-0.5 size-5 shrink-0 animate-spin text-primary"
              aria-hidden="true"
            />
          ) : (
            <CalendarDays className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden="true" />
          )}
          <div className={`${SUPPORT_PAIR} min-w-0 flex-1`}>
            <h2 className="m-0 text-base font-semibold">{calendarTitle}</h2>
            <p className="m-0 text-ink-2">
              {total > 0
                ? `Created ${completed} · Pending ${model.reconciliation.pending} · Failed ${model.reconciliation.failed} · Total ${total}`
                : "Only today plus the next six civil dates will be written."}
            </p>
          </div>
          {verified ? (
            <span className="rounded-full border border-ok px-3 py-1 text-sm text-ok">
              Verified
            </span>
          ) : null}
        </div>
        {total > 0 ? (
          <div
            className="h-2 overflow-hidden rounded-full bg-sunk"
            role="progressbar"
            aria-label="Intervals calendar update"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
          >
            <div className="h-full rounded-full bg-primary" style={{ width: `${percent}%` }} />
          </div>
        ) : null}
        {!running && !verified ? (
          <div className="flex flex-wrap justify-end gap-inset">
            {failed ? (
              <Button
                type="button"
                variant="outline"
                disabled={actions === null}
                onClick={() => actions?.verifyReconciliation()}
              >
                Verify again
              </Button>
            ) : null}
            <Button
              type="button"
              disabled={actions === null}
              onClick={() => actions?.reconcilePlan()}
            >
              {failed
                ? "Retry"
                : model.scenarioId === "PL-S037"
                  ? "View calendar progress"
                  : "Update Intervals"}
            </Button>
          </div>
        ) : null}
      </section>

      <section className="overflow-hidden rounded-card bg-surface shadow-elev-1">
        <div className="flex items-start justify-between gap-row px-5 py-row">
          <div className={SUPPORT_PAIR}>
            <h2 className="m-0 text-base font-semibold">This week</h2>
            <p className="m-0 text-sm text-ink-2">
              {data.matchSync?.awaitingSync === true
                ? "Awaiting sync · previous matches remain visible."
                : data.matchSync?.lastSuccessfulSyncAtMs == null
                  ? "Workout matches appear after activity sync."
                  : `As of last sync · ${new Intl.DateTimeFormat(undefined, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    }).format(new Date(data.matchSync.lastSuccessfulSyncAtMs))}`}
            </p>
          </div>
        </div>
        <div className="divide-y divide-line border-t border-line">
          {data.workouts.map((workout) => {
            const status = workout.match?.status ?? "upcoming";
            const decision = status === "decision-needed";
            const drift = workout.drift !== undefined;
            const proposal = (data.proposals ?? []).find(
              (candidate) => candidate.targetWorkoutId === workout.id,
            );
            return (
              <button
                key={workout.id}
                id={`workout-row-${workout.id}`}
                type="button"
                className="grid w-full grid-cols-[minmax(7rem,0.8fr)_minmax(12rem,2fr)_minmax(5rem,0.6fr)_minmax(9rem,1fr)_auto] items-center gap-inset bg-transparent px-5 py-row text-left text-sm hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary"
                onClick={() => {
                  if (proposal !== undefined) {
                    setProposalMode("proposal");
                    setRevisionText("");
                    actions?.openProposal(proposal.id);
                  } else actions?.openWorkout(workout.id);
                }}
              >
                <span className="text-ink-2">
                  {formatCivilDate(workout.date, { weekday: "short", day: "numeric" })}
                </span>
                <span className="font-medium text-ink-1">{workout.name}</span>
                <span className="text-ink-2">
                  {workout.durationS === null ? "—" : plannedTime(workout.durationS)}
                </span>
                {proposal !== undefined ? (
                  <span className="justify-self-start rounded-full border border-warn px-2.5 py-1 text-warn">
                    Decision needed
                  </span>
                ) : drift ? (
                  <span className="justify-self-start rounded-full border border-warn px-2.5 py-1 text-warn">
                    Changed in Intervals
                  </span>
                ) : decision ? (
                  <span className="justify-self-start rounded-full border border-warn px-2.5 py-1 text-warn">
                    Decision needed
                  </span>
                ) : (
                  <span className={matchStatusClass(status)}>{MATCH_STATUS_COPY[status]}</span>
                )}
                <ChevronRight className="size-4 text-ink-2" aria-hidden="true" />
              </button>
            );
          })}
        </div>
      </section>

      <Dialog
        open={selectedWorkout !== null}
        onOpenChange={(open) => {
          if (!open) actions?.closeWorkout();
        }}
      >
        <DialogContent className="top-0 right-0 left-auto flex h-full max-h-none w-[min(440px,calc(100%-32px))] max-w-none translate-x-0 translate-y-0 flex-col overflow-hidden rounded-none rounded-l-card border-y-0 border-r-0 p-0">
          {selectedWorkout === null ? null : (
            <>
              <DialogHeader className="grid gap-2 border-b border-line px-5 py-5 pr-16">
                <DialogTitle className="m-0 text-xl">{selectedWorkout.name}</DialogTitle>
                <DialogDescription className="m-0 text-ink-2">
                  {formatCivilDate(selectedWorkout.date)} · {selectedWorkout.sport} ·{" "}
                  {selectedWorkout.durationS === null
                    ? "No planned duration"
                    : plannedTime(selectedWorkout.durationS)}
                </DialogDescription>
              </DialogHeader>
              <div className="grid flex-1 content-start gap-row overflow-auto px-5 py-5">
                <div className={SUPPORT_PAIR}>
                  <h3 className="m-0 text-sm font-medium">WorkoutMatch</h3>
                  <p
                    className={`m-0 text-base ${matchStatusClass(
                      selectedWorkout.match?.status ?? "upcoming",
                    )}`}
                  >
                    {MATCH_STATUS_COPY[selectedWorkout.match?.status ?? "upcoming"]}
                  </p>
                </div>
                {selectedWorkout.match?.activityId !== null &&
                selectedWorkout.match?.activityId !== undefined ? (
                  <div className="grid gap-inset rounded-card bg-sunk p-row">
                    <p className="m-0 text-sm font-medium">Observed activity</p>
                    <p className="m-0 text-sm text-ink-2">
                      {selectedWorkout.match.actualDate === null
                        ? "Date unavailable"
                        : formatCivilDate(selectedWorkout.match.actualDate)}
                      {selectedWorkout.match.actualDurationS === null
                        ? ""
                        : ` · ${plannedTime(selectedWorkout.match.actualDurationS)}`}
                    </p>
                  </div>
                ) : (
                  <p className="m-0 text-sm text-ink-2">
                    No completed activity is matched to this workout.
                  </p>
                )}
                {selectedWorkout.match?.requiresConfirmation === true ? (
                  <p className="m-0 text-sm text-ink-2">
                    The date, sport, and duration look similar. Confirm before it counts as the
                    planned workout.
                  </p>
                ) : null}
              </div>
              <DialogFooter className="m-0 flex-row justify-end border-t border-line bg-surface px-5 py-row">
                {selectedWorkout.match?.requiresConfirmation === true &&
                selectedWorkout.match.activityId !== null ? (
                  <>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={actions === null || transition.status !== "idle"}
                      onClick={() =>
                        actions?.resolveWorkoutMatch(
                          selectedWorkout.id,
                          selectedWorkout.match!.activityId!,
                          "reject",
                        )
                      }
                    >
                      Not this activity
                    </Button>
                    <Button
                      type="button"
                      disabled={actions === null || transition.status !== "idle"}
                      onClick={() =>
                        actions?.resolveWorkoutMatch(
                          selectedWorkout.id,
                          selectedWorkout.match!.activityId!,
                          "confirm",
                        )
                      }
                    >
                      Confirm match
                    </Button>
                  </>
                ) : (
                  <Button type="button" variant="outline" onClick={() => actions?.closeWorkout()}>
                    Close
                  </Button>
                )}
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={selectedProposal !== null}
        onOpenChange={(open) => {
          if (!open) {
            setProposalMode("proposal");
            setRevisionText("");
            actions?.closeWorkout();
          }
        }}
      >
        <DialogContent className="top-0 right-0 left-auto flex h-full max-h-none w-[min(480px,calc(100%-32px))] max-w-none translate-x-0 translate-y-0 flex-col overflow-hidden rounded-none rounded-l-card border-y-0 border-r-0 p-0">
          {selectedProposal === null ? null : proposalMode === "evidence" ? (
            <>
              <DialogHeader className="grid gap-2 border-b border-line px-5 py-5 pr-16">
                <DialogTitle className="m-0 text-xl">Where this came from</DialogTitle>
                <DialogDescription className="m-0 text-ink-2">
                  Evidence captured when this Proposal was created.
                </DialogDescription>
              </DialogHeader>
              <div className="grid flex-1 content-start gap-6 overflow-auto px-5 py-5">
                <section className="grid gap-inset">
                  <h3 className="m-0 text-sm font-semibold">Source</h3>
                  {selectedProposal.premises.map((premise) => (
                    <p key={premise.id} className="m-0 text-sm text-ink-2">
                      {premise.sourceLabel}
                    </p>
                  ))}
                </section>
                <section className="grid gap-inset">
                  <h3 className="m-0 text-sm font-semibold">Evidence</h3>
                  <p className="m-0 text-sm text-ink-2">{selectedProposal.rationale}</p>
                </section>
                <section className="grid gap-inset">
                  <h3 className="m-0 text-sm font-semibold">Confidence</h3>
                  <p className="m-0 text-sm text-ink-2">{selectedProposal.confidence}</p>
                </section>
                <section className="grid gap-inset rounded-ctl bg-sunk p-row">
                  <h3 className="m-0 text-sm font-semibold">Proposed impact</h3>
                  {selectedProposal.diff.map((line) => (
                    <div key={line.field} className="grid grid-cols-[7rem_1fr] gap-inset text-sm">
                      <span>{line.label}</span>
                      <span>
                        {line.before} → {line.after}
                      </span>
                    </div>
                  ))}
                </section>
              </div>
              <DialogFooter className="m-0 flex-row justify-end border-t border-line bg-surface px-5 py-row">
                <Button
                  type="button"
                  onClick={() => {
                    setProposalMode("proposal");
                    requestAnimationFrame(() => evidenceTrigger.current?.focus());
                  }}
                >
                  Done
                </Button>
              </DialogFooter>
            </>
          ) : proposalMode === "edit" ? (
            <>
              <DialogHeader className="grid gap-2 border-b border-line px-5 py-5 pr-16">
                <DialogTitle className="m-0 text-xl">Revise Proposal</DialogTitle>
                <DialogDescription className="m-0 text-ink-2">
                  The active Plan stays unchanged while the coach revises this Proposal.
                </DialogDescription>
              </DialogHeader>
              <form
                className="flex min-h-0 flex-1 flex-col"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!/\S/u.test(revisionText)) return;
                  actions?.reviseProposal(selectedProposal.id, revisionText.trim());
                }}
              >
                <div className="grid flex-1 content-start gap-row overflow-auto px-5 py-5">
                  <div className="grid gap-inset rounded-ctl bg-sunk p-row">
                    <p className="m-0 text-sm font-medium">Coach</p>
                    <p className="m-0 text-sm text-ink-2">
                      I’ll keep the active Plan unchanged while we revise this Proposal. What should
                      change?
                    </p>
                  </div>
                  <label className="grid gap-inset text-sm font-medium" htmlFor="proposal-revision">
                    Your change
                    <textarea
                      id="proposal-revision"
                      className="min-h-36 resize-y rounded-ctl border border-line bg-surface px-3 py-3 text-base text-ink-1 outline-none focus:border-primary"
                      value={revisionText}
                      placeholder="Keep 45 minutes and make it recovery."
                      disabled={proposalBusy}
                      onChange={(event) => setRevisionText(event.currentTarget.value)}
                    />
                  </label>
                  {selectedProposal.error === null ? null : (
                    <StaleNotice message={selectedProposal.error.message} />
                  )}
                </div>
                <DialogFooter className="m-0 flex-row justify-end border-t border-line bg-surface px-5 py-row">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={proposalBusy}
                    onClick={() => {
                      setProposalMode("proposal");
                      setRevisionText("");
                    }}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" disabled={proposalBusy || !/\S/u.test(revisionText)}>
                    {proposalBusy ? "Updating…" : "Update Proposal"}
                  </Button>
                </DialogFooter>
              </form>
            </>
          ) : (
            <>
              <DialogHeader className="grid gap-2 border-b border-line px-5 py-5 pr-16">
                <DialogTitle className="m-0 text-xl">{selectedProposal.title}</DialogTitle>
                <DialogDescription className="m-0 text-ink-2">
                  {selectedProposal.rationale}
                </DialogDescription>
              </DialogHeader>
              <div className="grid flex-1 content-start gap-row overflow-auto px-5 py-5">
                {selectedProposal.stale ? (
                  <StaleNotice message="The Plan changed before approval. Review this updated Proposal." />
                ) : null}
                {!selectedProposal.stale && selectedProposal.error !== null ? (
                  <StaleNotice message={selectedProposal.error.message} />
                ) : null}
                {proposalBusy && transition.transitionId === "PL-T19" ? (
                  <div className="flex items-start gap-row rounded-ctl bg-sunk p-row" role="status">
                    <LoaderCircle
                      className="mt-0.5 size-5 animate-spin text-primary"
                      aria-hidden="true"
                    />
                    <div className={SUPPORT_PAIR}>
                      <p className="m-0 font-medium">Checking the current Plan</p>
                      <p className="m-0 text-sm text-ink-2">
                        Confirming that the workout and source data have not changed.
                      </p>
                    </div>
                  </div>
                ) : null}
                <section className="grid gap-inset rounded-ctl bg-sunk p-row">
                  <h3 className="m-0 text-sm font-semibold">Proposed change</h3>
                  {selectedProposal.diff.map((line) => (
                    <div key={line.field} className="grid grid-cols-[7rem_1fr] gap-inset text-sm">
                      <span>{line.label}</span>
                      <span>
                        {line.before} → {line.after}
                      </span>
                    </div>
                  ))}
                </section>
                <div className="flex items-center justify-between gap-inset">
                  <span className="text-sm text-ink-2">
                    Confidence · {selectedProposal.confidence}
                  </span>
                  <Button
                    ref={evidenceTrigger}
                    type="button"
                    variant="outline"
                    onClick={() => setProposalMode("evidence")}
                  >
                    View evidence
                  </Button>
                </div>
              </div>
              <DialogFooter className="m-0 flex-row justify-end border-t border-line bg-surface px-5 py-row">
                <>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={proposalBusy}
                    onClick={() => actions?.rejectProposal(selectedProposal.id)}
                  >
                    Reject
                  </Button>
                  {canReviseProposal ? (
                    <Button
                      type="button"
                      variant="outline"
                      disabled={proposalBusy}
                      onClick={() => setProposalMode("edit")}
                    >
                      Edit
                    </Button>
                  ) : null}
                  {canApproveProposal ? (
                    <Button
                      type="button"
                      disabled={proposalBusy}
                      onClick={() =>
                        actions?.approveProposal(selectedProposal.id, selectedProposal.revision)
                      }
                    >
                      {proposalBusy
                        ? "Checking…"
                        : selectedProposal.stale
                          ? "Revalidate"
                          : "Approve"}
                    </Button>
                  ) : null}
                </>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ReadyProjection(): ReactElement {
  const model = useEnduragentStore((state) => planReadModel(state.plan));
  const transition = useEnduragentStore((state) => state.plan.transition);
  if (
    transition.status === "running" &&
    (transition.transitionId === "PL-T06" || transition.transitionId === "PL-T07")
  ) {
    return <DraftFormation />;
  }
  if (model === null) return <StatusCard title="Plan" support="Refreshing your Plan…" />;
  if (model.lifecycle === "none" || model.projection === "no-plan") return <NoPlan />;
  if (model.projection === "coach") return <PlanCoach />;
  if (model.projection === "draft") return <DraftProjection />;
  if (model.projection === "active") return <ActiveProjection />;
  if (model.projection === "attention") return <AttentionProjection />;
  return (
    <StatusCard
      title={model.title.length > 0 ? model.title : "Your Plan"}
      support={model.summary.length > 0 ? model.summary : "Your Plan is available."}
    />
  );
}

export function PlanView(): ReactElement {
  const plan = useEnduragentStore((state) => state.plan);
  const model = planReadModel(plan);
  const loading = plan.hydration.status === "loading";
  const subtitle = loading
    ? "Loading…"
    : model?.lifecycle === "none"
      ? "No active plan"
      : undefined;

  return (
    <Page title="Plan" subtitle={subtitle} busy={loading} className="plan-view">
      <div className="grid gap-6">
        {plan.hydration.status === "stale" ? (
          <StaleNotice message={plan.hydration.error.message} />
        ) : null}
        {plan.hydration.status === "loading" ? (
          <p className="m-0 text-ink-2" role="status" aria-live="polite">
            Loading your Plan…
          </p>
        ) : plan.hydration.status === "failed" ? (
          <StatusCard
            title="Plan could not load"
            support={plan.hydration.error.message}
            retry={plan.hydration.error.retryable}
          />
        ) : plan.hydration.status === "unsupported-capability" ? (
          <StatusCard
            title="Plan is not available yet"
            support="Update Enduragent and its local service to use Plan."
          />
        ) : (
          <ReadyProjection />
        )}
        <CoursePickerDialog />
      </div>
    </Page>
  );
}
