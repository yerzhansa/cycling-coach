import type { PlanCreationAnswerInput, PlanCreationOpenQuestion } from "@enduragent/coach-contract";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactElement,
  type RefObject,
} from "react";
import { ChevronRight, Plus } from "lucide-react";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";

const fieldClass =
  "min-h-[calc(var(--ctl-h-lg)+var(--inset))] resize-y rounded-ctl border border-line-2 bg-sunk px-3 py-2 text-sm leading-5 text-ink outline-none focus:border-ring focus:ring-3 focus:ring-ring/20";
const radioClass =
  "grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-2 rounded-ctl border border-line-2 bg-surface px-3 py-2 text-sm leading-5 has-checked:border-primary has-checked:bg-primary/6";
const choiceClass =
  "grid h-auto min-w-0 grid-cols-[var(--ctl-h-sm)_minmax(0,1fr)_auto] items-center gap-inset whitespace-normal rounded-ctl px-3 py-2 text-left";

interface QuestionFormProps {
  readonly question: PlanCreationOpenQuestion;
  readonly currentAnswer: PlanCreationAnswerInput | null;
  readonly editing: boolean;
  readonly busy: boolean;
  readonly onAnswer: (answer: PlanCreationAnswerInput) => void;
  readonly onLater: () => void;
  readonly onCancel: () => void;
  readonly onEditorOpenChange: (open: boolean) => void;
}

function ChoiceRow(props: {
  readonly label: string;
  readonly description: string;
  readonly number?: number;
  readonly selected?: boolean;
  readonly disabled: boolean;
  readonly onClick: () => void;
}): ReactElement {
  return (
    <Button
      type="button"
      variant="outline"
      className={choiceClass}
      aria-label={props.label}
      aria-pressed={props.selected}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      <span className="grid size-[var(--ctl-h-sm)] place-items-center text-xs text-ink-2">
        {props.number === undefined ? <Plus aria-hidden="true" /> : props.number}
      </span>
      <span className="grid min-w-0 gap-[calc(var(--inset)/2)]">
        <strong className="font-medium">{props.label}</strong>
        <span className="text-ink-2">{props.description}</span>
      </span>
      <ChevronRight className="size-4 text-ink-3" aria-hidden="true" />
    </Button>
  );
}

function Actions(props: {
  readonly editing: boolean;
  readonly busy: boolean;
  readonly confirmLabel?: string;
  readonly onLater: () => void;
  readonly onCancel: () => void;
  readonly onBack?: () => void;
}): ReactElement {
  return (
    <div className="flex flex-wrap justify-end gap-inset pt-[calc(var(--inset)/2)]">
      {props.onBack === undefined ? null : (
        <Button type="button" variant="ghost" disabled={props.busy} onClick={props.onBack}>
          Cancel
        </Button>
      )}
      {props.editing && props.onBack === undefined ? (
        <Button type="button" variant="outline" disabled={props.busy} onClick={props.onCancel}>
          Cancel
        </Button>
      ) : null}
      <Button type="button" variant="outline" disabled={props.busy} onClick={props.onLater}>
        Later
      </Button>
      {props.confirmLabel === undefined ? null : (
        <Button type="submit" disabled={props.busy}>
          {props.confirmLabel}
        </Button>
      )}
    </div>
  );
}

function ErrorText(props: {
  readonly id: string;
  readonly children?: string;
}): ReactElement | null {
  return props.children === undefined ? null : (
    <p id={props.id} className="m-0 text-xs leading-4 text-danger" role="alert">
      {props.children}
    </p>
  );
}

function goalInitial(answer: PlanCreationAnswerInput | null): {
  readonly mode: "choices" | "manual" | "fitness";
  readonly name: string;
  readonly date: string;
  readonly outcome: string;
} {
  if (answer?.kind !== "goal") return { mode: "choices", name: "", date: "", outcome: "" };
  if (answer.goal.kind === "fitness") {
    return { mode: "fitness", name: "", date: "", outcome: answer.goal.outcome };
  }
  if (answer.goal.kind === "event-manual") {
    return { mode: "manual", name: answer.goal.name, date: answer.goal.date, outcome: "" };
  }
  return { mode: "choices", name: "", date: "", outcome: "" };
}

function GoalForm(props: QuestionFormProps): ReactElement {
  const question = props.question.kind === "goal-question" ? props.question : null;
  if (question === null) throw new TypeError("goal question required");
  const initial = goalInitial(props.currentAnswer);
  const selectedCandidateId =
    props.currentAnswer?.kind === "goal" && props.currentAnswer.goal.kind === "event-candidate"
      ? props.currentAnswer.goal.candidateId
      : null;
  const [mode, setMode] = useState(initial.mode);
  const [errors, setErrors] = useState<{ name?: string; date?: string; outcome?: string }>({});
  const editor = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  const nameErrorId = useId();
  const dateErrorId = useId();
  const outcomeErrorId = useId();
  useEffect(() => {
    const open = mode !== "choices";
    props.onEditorOpenChange(open);
    if (open) queueMicrotask(() => editor.current?.focus());
    return () => props.onEditorOpenChange(false);
  }, [mode, props.onEditorOpenChange]);
  if (mode === "choices") {
    return (
      <form key="goal-question-choices" className="grid min-w-0 gap-inset">
        <div className="grid min-w-0 gap-2">
          {question.candidates.map((candidate, index) => (
            <ChoiceRow
              key={candidate.candidateId}
              number={index + 1}
              label={`${candidate.name} · ${candidate.date}`}
              description={candidate.sourceLabel}
              selected={candidate.candidateId === selectedCandidateId}
              disabled={props.busy}
              onClick={() =>
                props.onAnswer({
                  kind: "goal",
                  goal: { kind: "event-candidate", candidateId: candidate.candidateId },
                })
              }
            />
          ))}
          <ChoiceRow
            number={question.candidates.length + 1}
            label={question.fitnessOption.label}
            description={question.fitnessOption.description}
            disabled={props.busy}
            onClick={() => setMode("fitness")}
          />
          <ChoiceRow
            label={question.manualOption.label}
            description={question.manualOption.description}
            disabled={props.busy}
            onClick={() => setMode("manual")}
          />
        </div>
        <Actions {...props} />
      </form>
    );
  }
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    if (mode === "fitness") {
      const outcome = data.get("outcome")?.toString().trim() ?? "";
      if (outcome.length === 0) {
        setErrors({ outcome: "Describe the Fitness Goal." });
        return;
      }
      setErrors({});
      props.onAnswer({ kind: "goal", goal: { kind: "fitness", outcome } });
      return;
    }
    const name = data.get("name")?.toString().trim() ?? "";
    const date = data.get("date")?.toString() ?? "";
    const nextErrors = {
      ...(name.length === 0 ? { name: "Enter the event name." } : {}),
      ...(date.length === 0 ? { date: "Choose the event date." } : {}),
    };
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    props.onAnswer({ kind: "goal", goal: { kind: "event-manual", name, date } });
  };
  return (
    <form
      key={mode === "fitness" ? "goal-question-fitness" : "goal-question-manual"}
      className="grid min-w-0 gap-inset"
      onSubmit={submit}
      noValidate
    >
      {mode === "fitness" ? (
        <label className="grid gap-[calc(var(--inset)/2)] text-xs font-semibold leading-4 text-ink-2">
          {question.fitnessOption.editorLabel}
          <textarea
            ref={editor as RefObject<HTMLTextAreaElement>}
            aria-describedby={errors.outcome === undefined ? undefined : outcomeErrorId}
            aria-invalid={errors.outcome !== undefined}
            aria-label="Goal outcome"
            className={fieldClass}
            name="outcome"
            placeholder={question.fitnessOption.placeholder}
            defaultValue={initial.outcome}
            maxLength={2000}
            rows={3}
          />
          <ErrorText id={outcomeErrorId}>{errors.outcome}</ErrorText>
        </label>
      ) : (
        <div className="grid min-w-0 gap-inset sm:grid-cols-2">
          <div className="grid gap-[calc(var(--inset)/2)]">
            <label className="grid gap-[calc(var(--inset)/2)] text-xs font-semibold leading-4 text-ink-2">
              {question.manualOption.nameLabel}
              <input
                ref={editor as RefObject<HTMLInputElement>}
                className={fieldClass}
                name="name"
                defaultValue={initial.name}
                maxLength={512}
                aria-describedby={errors.name === undefined ? undefined : nameErrorId}
                aria-invalid={errors.name !== undefined}
              />
            </label>
            <ErrorText id={nameErrorId}>{errors.name}</ErrorText>
          </div>
          <div className="grid gap-[calc(var(--inset)/2)]">
            <label className="grid gap-[calc(var(--inset)/2)] text-xs font-semibold leading-4 text-ink-2">
              {question.manualOption.dateLabel}
              <input
                className={fieldClass}
                name="date"
                type="date"
                defaultValue={initial.date}
                aria-describedby={errors.date === undefined ? undefined : dateErrorId}
                aria-invalid={errors.date !== undefined}
              />
            </label>
            <ErrorText id={dateErrorId}>{errors.date}</ErrorText>
          </div>
        </div>
      )}
      <Actions
        {...props}
        confirmLabel="Confirm goal"
        onBack={() => {
          setErrors({});
          setMode("choices");
        }}
      />
    </form>
  );
}

function SuccessForm(props: QuestionFormProps): ReactElement {
  const question = props.question.kind === "success-question" ? props.question : null;
  if (question === null) throw new TypeError("success question required");
  const [error, setError] = useState<string>();
  const errorId = useId();
  const currentSuccess = props.currentAnswer?.kind === "success" ? props.currentAnswer.success : null;
  const currentAuthored = currentSuccess?.kind === "authored" ? currentSuccess.text : "";
  const preset =
    question.input.kind === "authored"
      ? question.input.options.some((option) => option.text === currentAuthored)
      : false;
  const [mode, setMode] = useState<"choices" | "authored">(
    currentSuccess?.kind === "authored" && !preset ? "authored" : "choices",
  );
  const editor = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    props.onEditorOpenChange(mode === "authored");
    if (mode === "authored") queueMicrotask(() => editor.current?.focus());
    return () => props.onEditorOpenChange(false);
  }, [mode, props.onEditorOpenChange]);
  if (mode === "choices") {
    const options =
      question.input.kind === "event-finish"
        ? question.input.options.map((option) => ({
            key: option.choice,
            label: option.label,
            description: option.description,
            selected:
              currentSuccess?.kind === "event-finish" && currentSuccess.choice === option.choice,
            answer: {
              kind: "success" as const,
              success: { kind: "event-finish" as const, choice: option.choice },
            },
          }))
        : question.input.options.map((option) => ({
            key: option.text,
            label: option.label,
            description: option.description,
            selected: currentAuthored === option.text,
            answer: {
              kind: "success" as const,
              success: { kind: "authored" as const, text: option.text },
            },
          }));
    return (
      <form key="success-question-choices" className="grid min-w-0 gap-inset">
        <div className="grid min-w-0 gap-2" role="group" aria-label="Success outcome">
          {options.map((option, index) => (
            <ChoiceRow
              key={option.key}
              number={index + 1}
              label={option.label}
              description={option.description}
              selected={option.selected}
              disabled={props.busy}
              onClick={() => props.onAnswer(option.answer)}
            />
          ))}
          <ChoiceRow
            label={question.input.authored.label}
            description={question.input.authored.description}
            disabled={props.busy}
            onClick={() => setMode("authored")}
          />
        </div>
        <Actions {...props} />
      </form>
    );
  }
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const text = new FormData(event.currentTarget).get("success")?.toString().trim() ?? "";
    if (text.length === 0) {
      setError("Describe what success means.");
      return;
    }
    setError(undefined);
    props.onAnswer({ kind: "success", success: { kind: "authored", text } });
  };
  return (
    <form
      key="success-question-authored"
      className="grid min-w-0 gap-inset"
      onSubmit={submit}
      noValidate
    >
      <label className="grid gap-[calc(var(--inset)/2)] text-xs font-semibold leading-4 text-ink-2">
        {question.input.authored.editorLabel}
        <textarea
          ref={editor}
          aria-describedby={error === undefined ? undefined : errorId}
          aria-invalid={error !== undefined}
          aria-label="Success meaning"
          className={fieldClass}
          name="success"
          placeholder={question.input.authored.placeholder}
          defaultValue={currentAuthored}
          maxLength={2000}
          rows={3}
        />
      </label>
      <ErrorText id={errorId}>{error}</ErrorText>
      <Actions
        {...props}
        confirmLabel="Confirm success"
        onBack={() => {
          setError(undefined);
          setMode("choices");
        }}
      />
    </form>
  );
}

function PlanLengthForm(props: QuestionFormProps): ReactElement {
  const question = props.question.kind === "plan-length-question" ? props.question : null;
  if (question === null) throw new TypeError("plan length question required");
  const initial = props.currentAnswer?.kind === "plan-length" ? props.currentAnswer.weeks : null;
  const [error, setError] = useState<string>();
  const errorId = useId();
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const weeks = Number(new FormData(event.currentTarget).get("weeks"));
    if (weeks !== 4 && weeks !== 8 && weeks !== 12 && weeks !== 16) {
      setError("Choose a Plan length.");
      return;
    }
    setError(undefined);
    props.onAnswer({ kind: "plan-length", weeks });
  };
  return (
    <form
      key="plan-length-question"
      className="grid min-w-0 gap-inset"
      onSubmit={submit}
      noValidate
    >
      <fieldset
        className="m-0 grid min-w-0 gap-2 border-0 p-0 sm:grid-cols-2"
        aria-describedby={errorId}
      >
        <legend className="sr-only">Plan length</legend>
        {question.options.map((option) => (
          <label key={option.weeks} className={radioClass}>
            <input
              type="radio"
              name="weeks"
              value={option.weeks}
              aria-label={option.label}
              defaultChecked={option.weeks === initial}
            />
            <span className="grid gap-[calc(var(--inset)/2)]">
              <strong className="font-medium">{option.label}</strong>
              <span className="text-ink-2">{option.description}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <ErrorText id={errorId}>{error}</ErrorText>
      <Actions {...props} confirmLabel="Confirm length" />
    </form>
  );
}

function StartTimingForm(props: QuestionFormProps): ReactElement {
  const question = props.question.kind === "start-timing-question" ? props.question : null;
  if (question === null) throw new TypeError("start timing question required");
  const initialDate =
    props.currentAnswer?.kind === "start-timing" && props.currentAnswer.timing.kind === "earliest"
      ? props.currentAnswer.timing.date
      : "";
  const [timing, setTiming] = useState<"as-soon-as-possible" | "earliest">(
    initialDate.length > 0 ? "earliest" : "as-soon-as-possible",
  );
  const [error, setError] = useState<string>();
  const errorId = useId();
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (timing === "as-soon-as-possible") {
      setError(undefined);
      props.onAnswer({ kind: "start-timing", timing: { kind: "as-soon-as-possible" } });
      return;
    }
    const date = new FormData(event.currentTarget).get("date")?.toString() ?? "";
    if (date.length === 0 || date < question.earliestAllowed) {
      setError(`Choose a date on or after ${question.earliestAllowed}.`);
      return;
    }
    setError(undefined);
    props.onAnswer({ kind: "start-timing", timing: { kind: "earliest", date } });
  };
  return (
    <form
      key="start-timing-question"
      className="grid min-w-0 gap-inset"
      onSubmit={submit}
      noValidate
    >
      <fieldset className="m-0 grid min-w-0 gap-2 border-0 p-0">
        <legend className="sr-only">Start timing</legend>
        {question.options.map((option) => (
          <label key={option.timing} className={radioClass}>
            <input
              type="radio"
              name="timing"
              value={option.timing}
              aria-label={option.label}
              checked={timing === option.timing}
              onChange={() => setTiming(option.timing)}
            />
            <span className="grid gap-[calc(var(--inset)/2)]">
              <strong className="font-medium">{option.label}</strong>
              <span className="text-ink-2">{option.description}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {timing === "earliest" ? (
        <label className="grid gap-[calc(var(--inset)/2)] text-xs font-semibold leading-4 text-ink-2">
          {question.dateLabel}
          <input
            className={fieldClass}
            name="date"
            type="date"
            min={question.earliestAllowed}
            defaultValue={initialDate}
            aria-describedby={error === undefined ? undefined : errorId}
            aria-invalid={error !== undefined}
          />
        </label>
      ) : null}
      <ErrorText id={errorId}>{error}</ErrorText>
      <Actions {...props} confirmLabel="Confirm start" />
    </form>
  );
}

function ScheduleModeForm(props: QuestionFormProps): ReactElement {
  const question = props.question.kind === "schedule-mode-question" ? props.question : null;
  if (question === null) throw new TypeError("schedule mode question required");
  const initial = props.currentAnswer?.kind === "schedule-mode" ? props.currentAnswer.mode : null;
  const [error, setError] = useState<string>();
  const errorId = useId();
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const mode = new FormData(event.currentTarget).get("mode")?.toString();
    if (mode !== "fixed" && mode !== "flexible") {
      setError("Choose a Schedule mode.");
      return;
    }
    setError(undefined);
    props.onAnswer({ kind: "schedule-mode", mode });
  };
  return (
    <form
      key="schedule-mode-question"
      className="grid min-w-0 gap-inset"
      onSubmit={submit}
      noValidate
    >
      <fieldset className="m-0 grid min-w-0 gap-2 border-0 p-0" aria-describedby={errorId}>
        <legend className="sr-only">Schedule mode</legend>
        {question.options.map((option) => (
          <label key={option.mode} className={radioClass}>
            <input
              type="radio"
              name="mode"
              value={option.mode}
              aria-label={option.label}
              defaultChecked={option.mode === initial}
            />
            <span className="grid gap-[calc(var(--inset)/2)]">
              <strong className="font-medium">{option.label}</strong>
              <span className="text-ink-2">{option.description}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <ErrorText id={errorId}>{error}</ErrorText>
      <Actions {...props} confirmLabel="Confirm Schedule" />
    </form>
  );
}

const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

function AvailabilityForm(props: QuestionFormProps): ReactElement {
  const question = props.question.kind === "availability-question" ? props.question : null;
  if (question === null) throw new TypeError("availability question required");
  const initial = props.currentAnswer?.kind === "availability" ? props.currentAnswer : null;
  const [errors, setErrors] = useState<Record<string, string>>({});
  const weeklyErrorId = useId();
  const longestErrorId = useId();
  const weekdaysErrorId = useId();
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const weeklyHoursLimit = Number(data.get("weeklyHoursLimit"));
    const longestWorkoutHours = Number(data.get("longestWorkoutHours"));
    const nextErrors: Record<string, string> = {};
    if (!Number.isFinite(weeklyHoursLimit) || weeklyHoursLimit <= 0) {
      nextErrors.weekly = "Enter weekly hours greater than 0.";
    }
    if (!Number.isFinite(longestWorkoutHours) || longestWorkoutHours <= 0) {
      nextErrors.longest = "Enter a longest Workout greater than 0 hours.";
    } else if (Number.isFinite(weeklyHoursLimit) && longestWorkoutHours > weeklyHoursLimit) {
      nextErrors.longest = "The longest Workout cannot exceed the weekly limit.";
    }
    const usableWeekdays = data.getAll("usableWeekdays").map(Number);
    if (question.mode === "fixed" && usableWeekdays.length === 0) {
      nextErrors.weekdays = "Choose at least one usable weekday.";
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    props.onAnswer(
      question.mode === "fixed"
        ? {
            kind: "availability",
            mode: "fixed",
            weeklyHoursLimit,
            longestWorkoutHours,
            usableWeekdays,
          }
        : {
            kind: "availability",
            mode: "flexible",
            weeklyHoursLimit,
            longestWorkoutHours,
          },
    );
  };
  return (
    <form
      key={`availability-question-${question.mode}`}
      className="grid min-w-0 gap-inset"
      onSubmit={submit}
      noValidate
    >
      <div className="grid min-w-0 gap-inset sm:grid-cols-2">
        <div className="grid gap-[calc(var(--inset)/2)]">
          <label className="grid gap-[calc(var(--inset)/2)] text-xs font-semibold leading-4 text-ink-2">
            Weekly hours
            <input
              className={fieldClass}
              name="weeklyHoursLimit"
              type="number"
              defaultValue={initial?.weeklyHoursLimit ?? ""}
              aria-describedby={errors.weekly === undefined ? undefined : weeklyErrorId}
              aria-invalid={errors.weekly !== undefined}
            />
          </label>
          <ErrorText id={weeklyErrorId}>{errors.weekly}</ErrorText>
        </div>
        <div className="grid gap-[calc(var(--inset)/2)]">
          <label className="grid gap-[calc(var(--inset)/2)] text-xs font-semibold leading-4 text-ink-2">
            Longest Workout hours
            <input
              className={fieldClass}
              name="longestWorkoutHours"
              type="number"
              defaultValue={initial?.longestWorkoutHours ?? ""}
              aria-describedby={errors.longest === undefined ? undefined : longestErrorId}
              aria-invalid={errors.longest !== undefined}
            />
          </label>
          <ErrorText id={longestErrorId}>{errors.longest}</ErrorText>
        </div>
      </div>
      {question.mode === "fixed" ? (
        <fieldset
          className="m-0 grid min-w-0 gap-2 border-0 p-0"
          aria-describedby={weekdaysErrorId}
        >
          <legend className="text-xs font-semibold leading-4 text-ink-2">Usable weekdays</legend>
          <div className="grid grid-cols-4 gap-2 sm:grid-cols-7">
            {weekdays.map((day, index) => (
              <label
                key={day}
                className="grid justify-items-center gap-1 rounded-ctl border border-line-2 bg-surface px-2 py-2 text-xs"
              >
                <input
                  type="checkbox"
                  name="usableWeekdays"
                  value={index + 1}
                  defaultChecked={
                    initial?.mode === "fixed" && initial.usableWeekdays.includes(index + 1)
                  }
                />
                {day}
              </label>
            ))}
          </div>
          <ErrorText id={weekdaysErrorId}>{errors.weekdays}</ErrorText>
        </fieldset>
      ) : (
        <p className="m-0 text-xs leading-4 text-ink-2">{question.derivedPoolNote}</p>
      )}
      <Actions {...props} confirmLabel="Confirm availability" />
    </form>
  );
}

function CommitmentsForm(props: QuestionFormProps): ReactElement {
  const question = props.question.kind === "commitments-question" ? props.question : null;
  if (question === null) throw new TypeError("commitments question required");
  const currentCommitments =
    props.currentAnswer?.kind === "commitments" ? props.currentAnswer.commitments : null;
  const [mode, setMode] = useState<"choices" | "authored">(
    currentCommitments?.kind === "authored" ? "authored" : "choices",
  );
  const [error, setError] = useState<string>();
  const editor = useRef<HTMLTextAreaElement>(null);
  const errorId = useId();
  useEffect(() => {
    props.onEditorOpenChange(mode === "authored");
    if (mode === "authored") queueMicrotask(() => editor.current?.focus());
    return () => props.onEditorOpenChange(false);
  }, [mode, props.onEditorOpenChange]);
  if (mode === "choices") {
    return (
      <form key="commitments-question-choices" className="grid min-w-0 gap-inset">
        <div className="grid min-w-0 gap-2">
          <ChoiceRow
            number={1}
            label={question.noneOption.label}
            description={question.noneOption.description}
            selected={currentCommitments?.kind === "none"}
            disabled={props.busy}
            onClick={() =>
              props.onAnswer({ kind: "commitments", commitments: { kind: "none" } })
            }
          />
          <ChoiceRow
            label={question.authoredOption.label}
            description={question.authoredOption.description}
            disabled={props.busy}
            onClick={() => setMode("authored")}
          />
        </div>
        <Actions {...props} />
      </form>
    );
  }
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const text = new FormData(event.currentTarget).get("commitments")?.toString().trim() ?? "";
    if (text.length === 0) {
      setError("Add the scheduling details or choose Nothing fixed.");
      return;
    }
    setError(undefined);
    props.onAnswer({ kind: "commitments", commitments: { kind: "authored", text } });
  };
  return (
    <form
      key="commitments-question"
      className="grid min-w-0 gap-inset"
      onSubmit={submit}
      noValidate
    >
      <label className="grid gap-[calc(var(--inset)/2)] text-xs font-semibold leading-4 text-ink-2">
        {question.authoredOption.editorLabel}
        <textarea
          ref={editor}
          className={fieldClass}
          name="commitments"
          placeholder={question.authoredOption.placeholder}
          defaultValue={currentCommitments?.kind === "authored" ? currentCommitments.text : ""}
          maxLength={2000}
          rows={3}
          aria-describedby={error === undefined ? undefined : errorId}
          aria-invalid={error !== undefined}
        />
      </label>
      <ErrorText id={errorId}>{error}</ErrorText>
      <Actions
        {...props}
        confirmLabel="Confirm commitments"
        onBack={() => {
          setError(undefined);
          setMode("choices");
        }}
      />
    </form>
  );
}

function BaselineForm(props: QuestionFormProps): ReactElement {
  const question = props.question.kind === "baseline-question" ? props.question : null;
  if (question === null) throw new TypeError("baseline question required");
  const initial = props.currentAnswer?.kind === "baseline" ? props.currentAnswer.baseline : null;
  const [error, setError] = useState<string>();
  const errorId = useId();
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const baseline = new FormData(event.currentTarget).get("baseline")?.toString();
    if (baseline !== "regular" && baseline !== "occasional" && baseline !== "starting-again") {
      setError("Choose a recent training baseline.");
      return;
    }
    setError(undefined);
    props.onAnswer({ kind: "baseline", baseline });
  };
  return (
    <form key="baseline-question" className="grid min-w-0 gap-inset" onSubmit={submit} noValidate>
      <fieldset className="m-0 grid min-w-0 gap-2 border-0 p-0" aria-describedby={errorId}>
        <legend className="sr-only">Recent training baseline</legend>
        {question.options.map((option) => (
          <label key={option.baseline} className={radioClass}>
            <input
              type="radio"
              name="baseline"
              value={option.baseline}
              aria-label={option.label}
              defaultChecked={option.baseline === initial}
            />
            <span className="grid gap-[calc(var(--inset)/2)]">
              <strong className="font-medium">{option.label}</strong>
              <span className="text-ink-2">{option.description}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <ErrorText id={errorId}>{error}</ErrorText>
      <Actions {...props} confirmLabel="Confirm baseline" />
    </form>
  );
}

type RestrictionKind = "none" | "no-training" | "no-hard-training" | "max-duration";

function restrictionInitial(answer: PlanCreationAnswerInput | null): {
  readonly kind: RestrictionKind;
  readonly hours: string;
  readonly endDate: string;
} {
  const restriction = answer?.kind === "restriction" ? answer.restriction : null;
  const kind = restriction?.kind ?? "none";
  return {
    kind,
    hours: restriction?.kind === "max-duration" ? String(restriction.hours) : "",
    endDate: restriction !== null && restriction.kind !== "none" ? (restriction.endDate ?? "") : "",
  };
}

function RestrictionForm(props: QuestionFormProps): ReactElement {
  const question = props.question.kind === "restriction-question" ? props.question : null;
  if (question === null) throw new TypeError("restriction question required");
  const initial = restrictionInitial(props.currentAnswer);
  const [kind, setKind] = useState<RestrictionKind>(initial.kind);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const kindErrorId = useId();
  const hoursErrorId = useId();
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    if (kind === "none") {
      setErrors({});
      props.onAnswer({ kind: "restriction", restriction: { kind: "none" } });
      return;
    }
    const endDate = data.get("endDate")?.toString() || undefined;
    if (kind === "max-duration") {
      const hours = Number(data.get("hours"));
      if (!Number.isFinite(hours) || hours <= 0) {
        setErrors({ hours: "Enter a duration greater than 0 hours." });
        return;
      }
      setErrors({});
      props.onAnswer({
        kind: "restriction",
        restriction: { kind: "max-duration", hours, ...(endDate === undefined ? {} : { endDate }) },
      });
      return;
    }
    setErrors({});
    props.onAnswer({
      kind: "restriction",
      restriction: { kind, ...(endDate === undefined ? {} : { endDate }) },
    });
  };
  return (
    <form
      key="restriction-question"
      className="grid min-w-0 gap-inset"
      onSubmit={submit}
      noValidate
    >
      <fieldset className="m-0 grid min-w-0 gap-2 border-0 p-0" aria-describedby={kindErrorId}>
        <legend className="sr-only">Training Restriction</legend>
        {question.options.map((option) => (
          <label key={option.kind} className={radioClass}>
            <input
              type="radio"
              name="restriction"
              value={option.kind}
              aria-label={option.label}
              checked={kind === option.kind}
              onChange={() => setKind(option.kind)}
            />
            <span className="grid gap-[calc(var(--inset)/2)]">
              <strong className="font-medium">{option.label}</strong>
              <span className="text-ink-2">{option.description}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <ErrorText id={kindErrorId}>{errors.kind}</ErrorText>
      {kind === "max-duration" ? (
        <div className="grid gap-[calc(var(--inset)/2)]">
          <label className="grid gap-[calc(var(--inset)/2)] text-xs font-semibold leading-4 text-ink-2">
            Maximum duration hours
            <input
              className={fieldClass}
              name="hours"
              type="number"
              defaultValue={initial.hours}
              aria-describedby={errors.hours === undefined ? undefined : hoursErrorId}
              aria-invalid={errors.hours !== undefined}
            />
          </label>
          <ErrorText id={hoursErrorId}>{errors.hours}</ErrorText>
        </div>
      ) : null}
      {kind === "none" ? null : (
        <label className="grid gap-[calc(var(--inset)/2)] text-xs font-semibold leading-4 text-ink-2">
          Optional end date
          <input className={fieldClass} name="endDate" type="date" defaultValue={initial.endDate} />
        </label>
      )}
      <Actions {...props} confirmLabel="Confirm restriction" />
    </form>
  );
}

function QuestionForm(props: QuestionFormProps): ReactElement {
  switch (props.question.kind) {
    case "goal-question":
      return <GoalForm {...props} />;
    case "success-question":
      return <SuccessForm {...props} />;
    case "plan-length-question":
      return <PlanLengthForm {...props} />;
    case "start-timing-question":
      return <StartTimingForm {...props} />;
    case "schedule-mode-question":
      return <ScheduleModeForm {...props} />;
    case "availability-question":
      return <AvailabilityForm {...props} />;
    case "commitments-question":
      return <CommitmentsForm {...props} />;
    case "baseline-question":
      return <BaselineForm {...props} />;
    case "restriction-question":
      return <RestrictionForm {...props} />;
  }
}

export function PlanCreationQuestionCard(
  props: QuestionFormProps & {
    readonly error: string | null;
    readonly focusRevision: number;
  },
): ReactElement {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, [props.focusRevision, props.question.kind]);
  useEffect(() => {
    const later = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (document.querySelector('[role="dialog"]') !== null) return;
      if (document.querySelector('[role="listbox"][aria-label="Commands"]') !== null) return;
      event.preventDefault();
      props.onLater();
    };
    document.addEventListener("keydown", later);
    return () => document.removeEventListener("keydown", later);
  }, [props.onLater]);
  return (
    <Card className="min-w-0 shadow-elev-2">
      <CardHeader>
        <p className="m-0 text-xs font-semibold uppercase tracking-wide text-ink-2">
          Plan creation · question {props.question.step.current} of {props.question.step.total}
        </p>
        <CardTitle>
          <h2 ref={heading} tabIndex={-1} className="m-0 outline-none">
            {props.question.prompt}
          </h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="grid min-w-0 gap-inset">
        <QuestionForm {...props} />
        {props.error === null ? null : (
          <p className="m-0 text-xs leading-4 text-danger" role="alert">
            {props.error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
