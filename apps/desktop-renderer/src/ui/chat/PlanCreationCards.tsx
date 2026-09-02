import type { PlanCreationCardModel } from "@enduragent/coach-contract";
import { useCallback, useEffect, useRef, type ReactElement } from "react";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { useEnduragentStore } from "../../state/store";
import { PlanCreationQuestionCard } from "./PlanCreationQuestionCard";
import { PlanCreationSummary } from "./PlanCreationSummary";

export function PlanCreationDiscardDialog(): ReactElement {
  const open = useEnduragentStore((state) => state.chat.planCreationDiscardConfirmationOpen);
  const busy = useEnduragentStore((state) => state.chat.planCreationBusy);
  const error = useEnduragentStore((state) => state.chat.planCreationError);
  const actions = useEnduragentStore((state) => state.chatActions);
  const keepCreating = useRef<HTMLButtonElement>(null);
  const cancelDiscard = useCallback((): void => {
    actions?.cancelPlanCreationDiscard();
  }, [actions]);
  const confirmDiscard = useCallback((): void => {
    actions?.confirmPlanCreationDiscard();
  }, [actions]);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !busy) cancelDiscard();
      }}
    >
      <DialogContent
        className="w-[min(520px,calc(100vw-32px))] max-w-none gap-normal border-line p-5 shadow-elev-4 sm:max-w-none"
        showCloseButton={false}
        initialFocus={keepCreating}
        finalFocus={false}
        aria-busy={busy ? "true" : undefined}
      >
        <DialogHeader className="gap-inset">
          <DialogTitle className="m-0 text-lg font-bold">Discard this Plan creation?</DialogTitle>
          <DialogDescription className="m-0 leading-5">
            No Plan is created. Your active Plan, Schedule, training restrictions, closed Plans,
            saved preferences, and chat history are unchanged.
          </DialogDescription>
        </DialogHeader>
        {error === null ? null : (
          <p className="mt-inset mb-0 text-xs text-danger" role="alert">
            {error}
          </p>
        )}
        <DialogFooter className="mx-0 mt-ctl-px-lg mb-0 flex-row justify-end rounded-none border-0 bg-transparent p-0">
          <DialogClose
            render={
              <Button
                ref={keepCreating}
                variant="outline"
                size="lg"
                disabled={busy || actions === null}
              />
            }
          >
            Keep creating
          </DialogClose>
          <Button
            variant="destructive-solid"
            size="lg"
            disabled={busy || actions === null}
            onClick={confirmDiscard}
          >
            Discard creation
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

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
  const focusRequest = useEnduragentStore((state) => state.chat.planCreationFocusRequest);
  const decision = useEnduragentStore((state) => state.chat.decision);
  const actions = useEnduragentStore((state) => state.chatActions);
  const startButton = useRef<HTMLButtonElement>(null);
  const decisionPending =
    decision?.status === "unanswered" ||
    (decision?.status === "answered" && decision.continuation.status === "pending");
  useEffect(() => {
    if (focusRequest?.target === "start") startButton.current?.focus();
  }, [focusRequest?.revision, focusRequest?.target]);
  if (!loaded) return null;
  if (model === null) {
    return (
      <div
        className="flex min-w-0 justify-end gap-[calc(var(--inset)*0.75)] rounded-card border border-line-2 bg-surface pt-row pr-ctl-px pb-row pl-[calc(var(--inset)*2)] shadow-elev-2"
        data-parity="start.row"
      >
        <Button
          ref={startButton}
          variant="outline"
          data-parity="start.button"
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

export function PlanCreationDiscardConsequence(props: {
  readonly eventId: string;
}): ReactElement {
  return (
    <article
      className="grid gap-row rounded-card border border-line bg-surface p-3"
      data-plan-creation-discard-event={props.eventId}
      data-parity="discarded.record"
    >
      <strong className="text-sm font-medium leading-5">Plan creation discarded</strong>
      <p className="m-0 text-xs leading-4 text-ink-2">
        No Plan was created. Your active Plan, Schedule, training restrictions, saved preferences,
        and chat history are unchanged.
      </p>
    </article>
  );
}
