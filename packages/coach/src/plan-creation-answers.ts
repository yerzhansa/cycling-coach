import {
  PLAN_CREATION_ANSWER_KEYS,
  PlanCreationAnswerInputSchema,
  PlanCreationCardModelSchema,
  type PlanCreationAnswerInput,
  type PlanCreationAnswerSummary,
  type PlanCreationCardModel,
  type PlanCreationGoal,
  type PlanCreationOpenQuestion,
} from "@enduragent/coach-contract";
import { canonicalJson } from "@enduragent/kernel/archive";
import {
  PlanCreationStoreError,
  type PlanCreationAnswerRecord,
  type PlanCreationSnapshot,
} from "@enduragent/kernel/planning";

export type PlanCreationAnswerKey = (typeof PLAN_CREATION_ANSWER_KEYS)[number];

export type PlanCreationAnswerSource =
  | { readonly kind: "athlete" }
  | { readonly kind: "derived"; readonly label: string };

export interface PlanCreationBaselineEvidence {
  readonly baseline: "regular" | "occasional" | "starting-again";
  readonly label: string;
}

export interface PlanCreationProjectionContext {
  readonly today: string;
}

export interface StoredPlanCreationAnswer {
  readonly answer: PlanCreationAnswerInput;
  readonly source: PlanCreationAnswerSource;
  readonly record: PlanCreationAnswerRecord;
}

export interface PlanCreationAnswerFlow {
  readonly order: readonly PlanCreationAnswerKey[];
  readonly latest: ReadonlyMap<PlanCreationAnswerKey, StoredPlanCreationAnswer>;
  readonly valid: ReadonlyMap<PlanCreationAnswerKey, StoredPlanCreationAnswer>;
  readonly next: PlanCreationAnswerKey | null;
}

const corrupt = (): never => {
  throw new PlanCreationStoreError("corrupt-record");
};

const object = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : corrupt();

const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

const isAnswerKey = (value: string): value is PlanCreationAnswerKey =>
  (PLAN_CREATION_ANSWER_KEYS as readonly string[]).includes(value);

const parseSource = (value: unknown): PlanCreationAnswerSource => {
  const candidate = object(value);
  if (candidate.kind === "athlete" && hasExactKeys(candidate, ["kind"])) {
    return { kind: "athlete" };
  }
  if (
    candidate.kind === "derived" &&
    typeof candidate.label === "string" &&
    hasExactKeys(candidate, ["kind", "label"])
  ) {
    return { kind: "derived", label: candidate.label };
  }
  return corrupt();
};

const parseStoredAnswer = (record: PlanCreationAnswerRecord): StoredPlanCreationAnswer => {
  let decoded: unknown;
  try {
    decoded = JSON.parse(record.valueJson) as unknown;
  } catch {
    return corrupt();
  }
  const stored = object(decoded);
  if (!isAnswerKey(record.answerKey)) return corrupt();
  if (hasExactKeys(stored, ["answer", "source"])) {
    const answer = PlanCreationAnswerInputSchema.safeParse(stored.answer);
    if (!answer.success || answer.data.kind !== record.answerKey) return corrupt();
    return { answer: answer.data, source: parseSource(stored.source), record };
  }
  const legacyAnswer = PlanCreationAnswerInputSchema.safeParse(stored);
  if (!legacyAnswer.success || legacyAnswer.data.kind !== record.answerKey) return corrupt();
  return { answer: legacyAnswer.data, source: { kind: "athlete" }, record };
};

export const encodePlanCreationAnswer = (
  answer: PlanCreationAnswerInput,
  source: PlanCreationAnswerSource,
): string => canonicalJson({ answer, source });

export const readPlanCreationAnswers = (
  snapshot: PlanCreationSnapshot,
): readonly StoredPlanCreationAnswer[] => snapshot.answers.map(parseStoredAnswer);

const goalKind = (
  answer: Extract<PlanCreationAnswerInput, { kind: "goal" }>,
): PlanCreationGoal["kind"] => answer.goal.kind;

const currentGoalRunStart = (
  answers: readonly StoredPlanCreationAnswer[],
): { readonly kind: PlanCreationGoal["kind"]; readonly sequence: number } | undefined => {
  const goals = answers.filter(
    (
      stored,
    ): stored is StoredPlanCreationAnswer & {
      readonly answer: Extract<PlanCreationAnswerInput, { kind: "goal" }>;
    } => stored.answer.kind === "goal",
  );
  const current = goals.at(-1);
  if (current === undefined) return undefined;
  const kind = goalKind(current.answer);
  let sequence = current.record.sequence;
  for (let index = goals.length - 2; index >= 0; index -= 1) {
    const prior = goals[index]!;
    if (goalKind(prior.answer) !== kind) break;
    sequence = prior.record.sequence;
  }
  return { kind, sequence };
};

export function resolvePlanCreationAnswerFlow(
  snapshot: PlanCreationSnapshot,
): PlanCreationAnswerFlow {
  const answers = readPlanCreationAnswers(snapshot);
  const latest = new Map<PlanCreationAnswerKey, StoredPlanCreationAnswer>();
  for (const stored of answers) latest.set(stored.answer.kind, stored);
  const goalRun = currentGoalRunStart(answers);
  const order: readonly PlanCreationAnswerKey[] =
    goalRun?.kind === "fitness"
      ? [
          "goal",
          "success",
          "plan-length",
          "start-timing",
          "schedule-mode",
          "availability",
          "commitments",
          "baseline",
          "restriction",
        ]
      : goalRun !== undefined
        ? [
            "goal",
            "success",
            "start-timing",
            "schedule-mode",
            "availability",
            "commitments",
            "baseline",
            "restriction",
          ]
        : ["goal"];
  const valid = new Map<PlanCreationAnswerKey, StoredPlanCreationAnswer>();
  for (const key of order) {
    const stored = latest.get(key);
    if (stored === undefined) continue;
    if (key === "success") {
      const matchesGoal =
        goalRun?.kind === "fitness"
          ? stored.answer.kind === "success" && stored.answer.success.kind === "authored"
          : goalRun !== undefined
            ? stored.answer.kind === "success"
            : false;
      if (!matchesGoal || goalRun === undefined || stored.record.sequence <= goalRun.sequence) {
        continue;
      }
    }
    if (
      key === "plan-length" &&
      (goalRun?.kind !== "fitness" || stored.record.sequence <= goalRun.sequence)
    ) {
      continue;
    }
    if (key === "availability") {
      const scheduleMode = latest.get("schedule-mode")?.answer;
      if (
        stored.answer.kind !== "availability" ||
        scheduleMode?.kind !== "schedule-mode" ||
        stored.answer.mode !== scheduleMode.mode
      ) {
        continue;
      }
    }
    valid.set(key, stored);
  }
  return { order, latest, valid, next: order.find((key) => !valid.has(key)) ?? null };
}

const required = (
  flow: PlanCreationAnswerFlow,
  key: PlanCreationAnswerKey,
): StoredPlanCreationAnswer => flow.valid.get(key) ?? corrupt();

const requireGoal = (flow: PlanCreationAnswerFlow): PlanCreationGoal => {
  const answer = required(flow, "goal").answer;
  return answer.kind === "goal" ? answer.goal : corrupt();
};

const hours = (value: number): string => `${value} h`;

const baselineDetail = (baseline: "regular" | "occasional" | "starting-again"): string => {
  if (baseline === "regular") return "Training regularly";
  if (baseline === "occasional") return "Training occasionally";
  return "Starting again";
};

function goalDetail(snapshot: PlanCreationSnapshot, goal: PlanCreationGoal): string {
  if (goal.kind === "fitness") return goal.outcome;
  if (goal.kind === "event-manual") return `${goal.name} · ${goal.date}`;
  const candidate = snapshot.seed?.eventCandidates.find(
    (item) => item.candidateId === goal.candidateId,
  );
  if (candidate === undefined) return corrupt();
  return `${candidate.name} · ${candidate.date} · ${candidate.sourceLabel}`;
}

const successDetail = (answer: Extract<PlanCreationAnswerInput, { kind: "success" }>): string => {
  if (answer.success.kind === "authored") return answer.success.text;
  if (answer.success.choice === "finish-comfortably") return "Finish comfortably";
  if (answer.success.choice === "finish-fast") return "Finish fast";
  return "Race for a result";
};

const availabilityDetail = (
  answer: Extract<PlanCreationAnswerInput, { kind: "availability" }>,
): string => {
  const limits = `Up to ${hours(answer.weeklyHoursLimit)} a week, longest Workout ${hours(answer.longestWorkoutHours)}`;
  if (answer.mode === "flexible") {
    const poolSize = answer.weeklyHoursLimit <= 6 ? 3 : answer.weeklyHoursLimit <= 8 ? 4 : 5;
    return `${limits}, ${poolSize} Workouts in the flexible pool`;
  }
  const names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const weekdays = [...answer.usableWeekdays]
    .sort((left, right) => left - right)
    .map((weekday) => names[weekday - 1])
    .join(" ");
  return `${limits}, ${weekdays}`;
};

const restrictionDetail = (
  restriction: Extract<PlanCreationAnswerInput, { kind: "restriction" }>["restriction"],
): string => {
  if (restriction.kind === "none") return "No training restrictions";
  const end = restriction.endDate === undefined ? "" : ` until ${restriction.endDate}`;
  if (restriction.kind === "no-training") return `No training${end}`;
  if (restriction.kind === "no-hard-training") return `No hard training${end}`;
  return `Maximum Workout duration ${hours(restriction.hours)}${end}`;
};

function answerSummary(
  snapshot: PlanCreationSnapshot,
  stored: StoredPlanCreationAnswer,
  question: PlanCreationOpenQuestion,
): PlanCreationAnswerSummary {
  const answer = stored.answer;
  const shared = { answerKey: answer.kind, question, answer, source: stored.source };
  switch (answer.kind) {
    case "goal":
      return { ...shared, title: "Goal", detail: goalDetail(snapshot, answer.goal) };
    case "success":
      return { ...shared, title: "Success", detail: successDetail(answer) };
    case "plan-length":
      return { ...shared, title: "Plan length", detail: `${answer.weeks} weeks` };
    case "start-timing":
      return {
        ...shared,
        title: "Start timing",
        detail:
          answer.timing.kind === "as-soon-as-possible"
            ? "As soon as possible"
            : `Earliest start ${answer.timing.date}`,
      };
    case "schedule-mode":
      return {
        ...shared,
        title: "Schedule mode",
        detail: answer.mode === "fixed" ? "Fixed Schedule" : "Flexible Schedule",
      };
    case "availability":
      return { ...shared, title: "Availability", detail: availabilityDetail(answer) };
    case "commitments":
      return {
        ...shared,
        title: "Commitments",
        detail:
          answer.commitments.kind === "none"
            ? "No fixed commitments, other training, or time off"
            : answer.commitments.text,
      };
    case "baseline":
      return {
        ...shared,
        title: "Training baseline",
        detail: baselineDetail(answer.baseline),
      };
    case "restriction":
      return {
        ...shared,
        title: "Training Restriction",
        detail: restrictionDetail(answer.restriction),
      };
  }
}

function questionForKey(
  snapshot: PlanCreationSnapshot,
  flow: PlanCreationAnswerFlow,
  context: PlanCreationProjectionContext,
  key: PlanCreationAnswerKey,
): PlanCreationOpenQuestion {
  const step = { current: flow.order.indexOf(key) + 1, total: flow.order.length };
  switch (key) {
    case "goal":
      return {
        kind: "goal-question",
        step,
        prompt: "What do you want this Plan to prepare you for?",
        candidates: [...(snapshot.seed?.eventCandidates ?? [])],
        manualOption: {
          label: "Something else",
          description: "Name an event and include its exact date.",
          editorLabel: "Name the event and include its exact date.",
          placeholder: "Event name",
          nameLabel: "Event name",
          dateLabel: "Event date",
        },
        fitnessOption: {
          label: "Improve without an event",
          description: "Build fitness for a fixed number of weeks.",
          editorLabel: "What do you want to improve?",
          placeholder: "Describe your Fitness Goal",
        },
      };
    case "success":
      return requireGoal(flow).kind === "fitness"
        ? {
            kind: "success-question",
            step,
            prompt: "What would success mean for this Fitness Goal?",
            input: {
              kind: "authored",
              options: [
                {
                  text: "Train consistently",
                  label: "Train consistently",
                  description:
                    "Complete most planned weeks without forcing missed Workouts back in.",
                },
                {
                  text: "Climb stronger",
                  label: "Climb stronger",
                  description: "Hold a steadier effort on longer climbs.",
                },
                {
                  text: "Ride farther comfortably",
                  label: "Ride farther comfortably",
                  description: "Finish longer rides with stable energy and form.",
                },
              ],
              authored: {
                label: "Something else",
                description: "Answer in your own words.",
                editorLabel: "Describe what success looks like at the end of this Plan.",
                placeholder: "Describe what success would look like",
              },
            },
          }
        : {
            kind: "success-question",
            step,
            prompt: "What would success mean for this Event Goal?",
            input: {
              kind: "event-finish",
              options: [
                {
                  choice: "finish-comfortably",
                  label: "Finish comfortably",
                  description: "Complete the event with enough left to enjoy the final hour.",
                },
                {
                  choice: "finish-fast",
                  label: "Finish fast",
                  description: "Hold a strong pace and finish the final climbs well.",
                },
                {
                  choice: "race-for-result",
                  label: "Race for a result",
                  description: "Prepare for the strongest result your current training supports.",
                },
              ],
              authored: {
                label: "Something else",
                description: "Answer in your own words.",
                editorLabel: "Describe what a successful event would feel like.",
                placeholder: "Describe what success would look like",
              },
            },
          };
    case "plan-length":
      return {
        kind: "plan-length-question",
        step,
        prompt: "How long should this Fitness Plan be?",
        options: [
          { weeks: 4, label: "4 weeks", description: "A short, focused block." },
          { weeks: 8, label: "8 weeks", description: "One full training cycle." },
          { weeks: 12, label: "12 weeks", description: "Room for steady progression." },
          { weeks: 16, label: "16 weeks", description: "The longest steady build." },
        ],
      };
    case "start-timing":
      return {
        kind: "start-timing-question",
        step,
        prompt: "When could this Plan start?",
        earliestAllowed: context.today,
        options: [
          {
            timing: "as-soon-as-possible",
            label: "As soon as possible",
            description: "Start with the earliest suitable training week.",
          },
          {
            timing: "earliest",
            label: "From a date",
            description: "Set the earliest date this Plan may begin.",
          },
        ],
        dateLabel: "Earliest start date",
      };
    case "schedule-mode":
      return {
        kind: "schedule-mode-question",
        step,
        prompt: "Should this Plan use a Fixed or Flexible Schedule?",
        options: [
          {
            mode: "fixed",
            label: "Fixed Schedule",
            description: "Place each Workout on one of your available weekdays.",
          },
          {
            mode: "flexible",
            label: "Flexible Schedule",
            description: "Choose from an ordered Workout pool during each week.",
          },
        ],
      };
    case "availability": {
      const scheduleMode = required(flow, "schedule-mode").answer;
      if (scheduleMode.kind !== "schedule-mode") return corrupt();
      return {
        kind: "availability-question",
        step,
        prompt: "How much training fits in a usual week?",
        mode: scheduleMode.mode,
        derivedPoolNote:
          scheduleMode.mode === "flexible"
            ? "Your weekly limit sets 3 Workouts up to 6 h, 4 up to 8 h, or 5 above 8 h."
            : "Choose every weekday you can usually train.",
      };
    }
    case "commitments":
      return {
        kind: "commitments-question",
        step,
        prompt: "Any fixed commitments, other training, or time off to account for?",
        noneOption: {
          label: "Nothing fixed",
          description: "No fixed commitments, other training, or time off to account for.",
        },
        authoredOption: {
          label: "Something else",
          description: "Add scheduling details in your own words.",
          editorLabel: "Scheduling details",
          placeholder: "Add only the scheduling details this Plan should account for",
        },
      };
    case "baseline":
      return {
        kind: "baseline-question",
        step,
        prompt: "What best describes your recent training?",
        options: [
          {
            baseline: "regular",
            label: "Regular",
            description: "I have been training consistently.",
          },
          {
            baseline: "occasional",
            label: "Occasional",
            description: "I have trained some weeks but not consistently.",
          },
          {
            baseline: "starting-again",
            label: "Starting again",
            description: "I need a conservative return to regular training.",
          },
        ],
      };
    case "restriction":
      return {
        kind: "restriction-question",
        step,
        prompt: "What Training Restriction should this Plan respect?",
        options: [
          {
            kind: "none",
            label: "No training restrictions",
            description: "No temporary operational limit needs to shape this Plan.",
          },
          {
            kind: "no-training",
            label: "No training",
            description: "Keep all Workouts out until the restriction changes.",
          },
          {
            kind: "no-hard-training",
            label: "No hard training for now",
            description: "Keep intensity out until the restriction changes.",
          },
          {
            kind: "max-duration",
            label: "I have a duration limit",
            description: "Set the longest Workout the Plan may use.",
          },
        ],
      };
  }
}

export function projectPlanCreationCard(
  snapshot: PlanCreationSnapshot,
  context: PlanCreationProjectionContext = {
    today: new Date().toISOString().slice(0, 10),
  },
): PlanCreationCardModel {
  if (snapshot.status !== "in-progress") return corrupt();
  const flow = resolvePlanCreationAnswerFlow(snapshot);
  const answeredSummaries = flow.order.flatMap((key) => {
    const stored = flow.valid.get(key);
    return stored === undefined
      ? []
      : [answerSummary(snapshot, stored, questionForKey(snapshot, flow, context, key))];
  });
  const question = flow.next === null ? null : questionForKey(snapshot, flow, context, flow.next);
  return PlanCreationCardModelSchema.parse({
    creationId: snapshot.id,
    version: snapshot.version,
    status: "in-progress",
    readiness: question === null ? "ready" : "incomplete",
    answeredSummaries,
    openQuestion: question,
  });
}

export function validPlanCreationAnswer(
  snapshot: PlanCreationSnapshot,
  flow: PlanCreationAnswerFlow,
  answer: PlanCreationAnswerInput,
  today: string,
): boolean {
  if (answer.kind === "goal") {
    const candidateId = answer.goal.kind === "event-candidate" ? answer.goal.candidateId : null;
    return (
      candidateId === null ||
      snapshot.seed?.eventCandidates.some((candidate) => candidate.candidateId === candidateId) ===
        true
    );
  }
  if (answer.kind === "success") {
    const goal = requireGoal(flow);
    return goal.kind === "fitness"
      ? answer.success.kind === "authored"
      : answer.success.kind === "event-finish" || answer.success.kind === "authored";
  }
  if (answer.kind === "plan-length") return requireGoal(flow).kind === "fitness";
  if (answer.kind === "start-timing") {
    return answer.timing.kind === "as-soon-as-possible" || answer.timing.date >= today;
  }
  if (answer.kind === "availability") {
    const scheduleMode = flow.valid.get("schedule-mode")?.answer;
    return scheduleMode?.kind === "schedule-mode" && answer.mode === scheduleMode.mode;
  }
  return true;
}
