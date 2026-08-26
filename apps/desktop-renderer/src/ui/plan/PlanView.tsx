import {
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  LoaderCircle,
  MapPinned,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type ReactElement } from "react";
import {
  PLAN_MIN_FULL_DAYS,
  PlanCoachProjectionDataSchema,
  type PlanDraftPlanProjection,
  type PlanFtpProjection,
  type PlanFtpSourceValue,
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
          <p key={item.id} className="m-0 py-3 text-sm">
            {item.title}
          </p>
        ))}
      </div>
    </section>
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
