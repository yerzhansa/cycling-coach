import type { PlanCreationCardModel } from "@enduragent/coach-contract";
import type { ReactElement } from "react";
import { Button } from "../../components/ui/button";
import { useEnduragentStore } from "../../state/store";
import { PlanCreationQuestionCard } from "./PlanCreationQuestionCard";
import { PlanCreationSummary } from "./PlanCreationSummary";

export function PlanCreationDock(props: {
  readonly onEditorOpenChange: (open: boolean) => void;
}): ReactElement | null {
  const model = useEnduragentStore((state) => state.chat.planCreation);
  const loaded = useEnduragentStore((state) => state.chat.planCreationLoaded);
  const busy = useEnduragentStore((state) => state.chat.planCreationBusy);
  const error = useEnduragentStore((state) => state.chat.planCreationError);
  const paused = useEnduragentStore((state) => state.chat.planCreationPaused);
  const editingKey = useEnduragentStore((state) => state.chat.planCreationEditingKey);
  const focusRevision = useEnduragentStore((state) => state.chat.planCreationFocusRevision);
  const decision = useEnduragentStore((state) => state.chat.decision);
  const actions = useEnduragentStore((state) => state.chatActions);
  const decisionPending =
    decision?.status === "unanswered" ||
    (decision?.status === "answered" && decision.continuation.status === "pending");
  if (!loaded) return null;
  if (model === null) {
    return (
      <div className="flex min-w-0 justify-end rounded-card border border-line bg-surface px-4 py-3">
        <Button
          variant="outline"
          disabled={busy || actions === null || decisionPending}
          onClick={() => actions?.startPlanCreation()}
        >
          Start a Plan
        </Button>
      </div>
    );
  }
  if (paused || (editingKey === null && model.openQuestion === null)) return null;
  const editedSummary =
    editingKey === null
      ? null
      : (model.answeredSummaries.find((summary) => summary.answerKey === editingKey) ?? null);
  const question = editedSummary?.question ?? model.openQuestion;
  if (question === null) return null;
  return (
    <PlanCreationQuestionCard
      key={`${model.creationId}:${model.version}:${editingKey ?? question.kind}`}
      question={question}
      currentAnswer={editedSummary?.answer ?? null}
      editing={editingKey !== null}
      busy={busy}
      error={error}
      focusRevision={focusRevision}
      onAnswer={(answer) => actions?.answerPlanCreation(answer)}
      onLater={() => actions?.pausePlanCreation()}
      onCancel={() => actions?.cancelPlanCreationEdit()}
      onEditorOpenChange={props.onEditorOpenChange}
    />
  );
}

export function PlanCreationConversation(props: {
  readonly model: PlanCreationCardModel | null;
}): ReactElement | null {
  if (props.model === null) return null;
  return <PlanCreationSummary model={props.model} />;
}
