import type {
  ListPlansResult,
  PlanCreationCardModel,
  PlanSummary,
} from "@enduragent/coach-contract";
import { useEffect, useRef, type ReactElement, type ReactNode } from "react";
import { CHAT_PLAN_CREATION_CONTINUE_MISSING_COPY } from "../../chat/controller";
import { Button } from "../../components/ui/button";
import { Card, CardContent } from "../../components/ui/card";
import { useEnduragentStore } from "../../state/store";

function dateLabel(value: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}T12:00:00Z`));
}

function LibraryCard(props: {
  readonly eyebrow?: string;
  readonly title: string;
  readonly status?: string;
  readonly summary: string;
  readonly children?: ReactNode;
}): ReactElement {
  return (
    <Card size="sm" className="min-w-0" role="region" aria-label={props.eyebrow ?? props.title}>
      <CardContent className="grid gap-inset">
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-inset">
          <div className="grid min-w-0 gap-[calc(var(--inset)/2)]">
            {props.eyebrow ? (
              <p className="m-0 text-xs font-semibold uppercase tracking-wide text-ink-2">
                {props.eyebrow}
              </p>
            ) : null}
            <h3 className="m-0 text-base leading-6 font-semibold break-words">{props.title}</h3>
          </div>
          {props.status ? (
            <span className="rounded-chip bg-ink/7 px-2 py-1 text-xs font-medium text-ink-2">
              {props.status}
            </span>
          ) : null}
        </div>
        <p className="m-0 text-sm leading-5 text-ink-2">{props.summary}</p>
        {props.children}
      </CardContent>
    </Card>
  );
}

function creationTitle(creation: PlanCreationCardModel): string {
  const summary = creation.answeredSummaries.find((answer) => answer.answerKey === "goal");
  if (summary?.answer.kind !== "goal") return "New Plan";
  const goal = summary.answer.goal;
  if (goal.kind === "fitness") return goal.outcome ?? "Improve fitness";
  if (goal.kind === "event-manual") return `${goal.name} · ${dateLabel(goal.date)}`;
  const candidate =
    summary.question.kind === "goal-question"
      ? summary.question.candidates.find((item) => item.candidateId === goal.candidateId)
      : undefined;
  return candidate === undefined
    ? summary.detail
    : `${candidate.name} · ${dateLabel(candidate.date)}`;
}

function spanLabel(plan: PlanSummary): string {
  return `${dateLabel(plan.start)} to ${dateLabel(plan.end)} · ${plan.weeks} weeks`;
}

export function PlanLibrary(props: {
  readonly library: ListPlansResult;
  readonly readDetails: () => void;
}): ReactElement {
  const actions = useEnduragentStore((state) => state.planLibraryActions);
  const chatActions = useEnduragentStore((state) => state.chatActions);
  const chatCreation = useEnduragentStore((state) => state.chat.planCreation);
  const notice = useEnduragentStore((state) => state.chat.notice);
  const error = useEnduragentStore((state) => state.chat.planCreationError);
  const paused = useEnduragentStore((state) => state.chat.planCreationPaused);
  const busy = useEnduragentStore((state) => state.chat.planCreationBusy);
  const focusRequest = useEnduragentStore((state) => state.chat.planCreationFocusRequest);
  const discard = useRef<HTMLButtonElement>(null);
  const { creation, active, closed } = props.library;
  const total =
    creation?.openQuestion?.step.total ??
    creation?.answeredSummaries[0]?.question.step.total ??
    creation?.answeredSummaries.length ??
    0;
  useEffect(() => {
    if (focusRequest?.target === "discard") {
      queueMicrotask(() => discard.current?.focus());
    }
  }, [focusRequest]);
  return (
    <section aria-label="Plan library" className="grid min-w-0 gap-inset">
      {notice !== CHAT_PLAN_CREATION_CONTINUE_MISSING_COPY ? null : (
        <p role="status" className="m-0 text-sm text-ink-2">
          {notice}
        </p>
      )}
      {error === null ? null : (
        <p role="alert" className="m-0 text-sm text-danger">
          {error}
        </p>
      )}
      {creation === null ? null : (
        <LibraryCard
          eyebrow="Plan creation"
          title={creationTitle(creation)}
          status={
            creation.draft !== null
              ? "Draft"
              : paused && chatCreation?.creationId === creation.creationId
                ? "Paused"
                : "In progress"
          }
          summary={`${creation.answeredSummaries.length} of ${total} answered. ${active === null ? "No Plan is active." : `${active.name} keeps running.`}`}
        >
          <div className="flex flex-wrap gap-inset">
            <Button
              ref={discard}
              variant="destructive"
              aria-haspopup="dialog"
              disabled={
                busy || chatActions === null || chatCreation?.creationId !== creation.creationId
              }
              onClick={() => chatActions?.openPlanCreationDiscard()}
            >
              Discard
            </Button>
            <Button
              disabled={busy || actions === null}
              onClick={() => actions?.continueCreation(creation)}
            >
              Continue in Chat
            </Button>
          </div>
        </LibraryCard>
      )}
      {active === null ? (
        <LibraryCard title="No active Plan" summary="Create a Plan when you are ready." />
      ) : (
        <LibraryCard
          eyebrow="Active Plan"
          title={active.name}
          status="Active"
          summary={spanLabel(active)}
        >
          <div className="flex flex-wrap gap-inset">
            <Button variant="outline" onClick={props.readDetails}>
              Read Plan details
            </Button>
            <Button disabled={actions === null} onClick={() => actions?.changeInChat()}>
              Change in Chat
            </Button>
          </div>
        </LibraryCard>
      )}
      {closed.map((plan) => (
        <LibraryCard
          key={plan.planId}
          eyebrow="Closed Plan"
          title={plan.name}
          status="Closed"
          summary={`${spanLabel(plan)} · ${plan.closeReason === "stopped" ? "Stopped" : plan.closeReason === "completed" ? "Completed" : "Unknown reason"}`}
        />
      ))}
    </section>
  );
}
