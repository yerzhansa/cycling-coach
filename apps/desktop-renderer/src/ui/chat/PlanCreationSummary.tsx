import type { PlanCreationCardModel } from "@enduragent/coach-contract";
import type { ReactElement } from "react";
import { Button } from "../../components/ui/button";
import { Card, CardContent } from "../../components/ui/card";
import { useEnduragentStore } from "../../state/store";

export function PlanCreationSummary(props: {
  readonly model: PlanCreationCardModel;
}): ReactElement {
  const actions = useEnduragentStore((state) => state.chatActions);
  const paused = useEnduragentStore((state) => state.chat.planCreationPaused);
  const editingKey = useEnduragentStore((state) => state.chat.planCreationEditingKey);
  const busy = useEnduragentStore((state) => state.chat.planCreationBusy);
  const ready = props.model.readiness === "ready";
  const canContinue = paused && props.model.openQuestion !== null;
  return (
    <section className="grid min-w-0 gap-inset" aria-label="Plan Creation progress">
      {props.model.answeredSummaries.length === 0 ? null : (
        <dl className="m-0 grid gap-2 rounded-card bg-sunk p-3">
          {props.model.answeredSummaries.map((summary) => (
            <div
              key={summary.answerKey}
              className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-inset text-sm"
            >
              <div className="grid min-w-0 gap-[calc(var(--inset)/2)]">
                <dt className="font-medium text-ink-2">
                  {summary.title} · {summary.source.kind === "athlete" ? "your answer" : summary.source.label}
                </dt>
                <dd className="m-0 min-w-0 break-words font-medium">{summary.detail}</dd>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={`Edit ${summary.title}`}
                disabled={actions === null || busy || editingKey !== null}
                onClick={() => actions?.editPlanCreation(summary.answerKey)}
              >
                Edit
              </Button>
            </div>
          ))}
        </dl>
      )}
      <Card size="sm" className="min-w-0">
        <CardContent className="grid gap-inset">
          <div className="grid gap-[calc(var(--inset)/2)]">
            <strong>Plan Creation</strong>
            <p className="m-0 text-xs text-ink-2">
              {ready
                ? "The essentials are complete. Draft preview arrives in a later update."
                : `${props.model.answeredSummaries.length} ${props.model.answeredSummaries.length === 1 ? "answer" : "answers"} confirmed`}
            </p>
          </div>
          {canContinue ? (
            <div className="flex justify-end">
              <Button
                type="button"
                variant="outline"
                disabled={actions === null || busy}
                onClick={() => actions?.continuePlanCreation()}
              >
                Continue
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </section>
  );
}
