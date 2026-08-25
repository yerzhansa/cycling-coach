import { CheckCircle2, LoaderCircle, RefreshCw, TriangleAlert } from "lucide-react";
import { useRef, useState, type FormEvent, type ReactElement } from "react";
import {
  PlanCoachProjectionDataSchema,
  type PlanFtpProjection,
  type PlanFtpSourceValue,
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

function DraftProjection(): ReactElement {
  const actions = useEnduragentStore((state) => state.planActions);
  const model = useEnduragentStore((state) => planReadModel(state.plan));
  const revisionComposer = useEnduragentStore((state) => state.plan.revisionComposer);
  const [instruction, setInstruction] = useState("");
  const parsed = model === null ? null : PlanCoachProjectionDataSchema.safeParse(model.data);
  const draft = parsed?.success === true ? parsed.data.draft : null;
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (/\S/u.test(instruction)) actions?.updateDraft(instruction);
  };
  return (
    <div className="grid gap-6" data-plan-scenario={model?.scenarioId}>
      <section className="grid gap-row rounded-card bg-surface p-5 shadow-elev-1">
        <div className={SUPPORT_PAIR}>
          <h2 className="m-0 text-lg font-semibold">{model?.title ?? "Draft Plan"}</h2>
          <p className="m-0 text-ink-2">{model?.summary}</p>
        </div>
        <div className="grid grid-cols-2 gap-inset rounded-card bg-sunk p-4">
          <div className={SUPPORT_PAIR}>
            <span className="text-xs text-ink-2">Revision</span>
            <strong>{draft?.revision ?? model?.revision ?? 1}</strong>
          </div>
          <div className={SUPPORT_PAIR}>
            <span className="text-xs text-ink-2">Status</span>
            <strong>Ready for review</strong>
          </div>
        </div>
        {revisionComposer ? (
          <form className="grid gap-inset pt-row" onSubmit={submit}>
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
          <div className="flex flex-wrap justify-end gap-inset pt-row">
            <Button type="button" variant="outline" onClick={() => actions?.openRevisionComposer()}>
              Back to coach
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => actions?.openDiscardConfirmation()}
            >
              Discard draft
            </Button>
          </div>
        )}
      </section>
      <DiscardDraftDialog />
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
      </div>
    </Page>
  );
}
