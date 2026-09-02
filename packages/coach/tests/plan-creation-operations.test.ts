import { describe, expect, it, vi } from "vitest";
import {
  PlanCreationCardModelSchema,
  type PlanCreationAnswerInput,
  type PlanCreationAnswerRpcResult,
  type PlanCreationCardModel,
} from "@enduragent/coach-contract";
import {
  PlanCreationStoreError,
  type PlanCreationAnswerRecord,
  type PlanCreationRepository,
  type PlanCreationSnapshot,
} from "@enduragent/kernel/planning";
import {
  createPlanCreationOperations,
  expectedPlanCreationAnswerKind,
  projectPlanCreationCard,
  type BaselineEvidenceSource,
} from "../src/plan-creation-operations.js";
import { readPlanCreationAnswers } from "../src/plan-creation-answers.js";

const id = (value: string) => `${"0".repeat(26 - value.length)}${value}`;
const today = "1998-09-02";
const eventCandidate = {
  candidateId: id("2"),
  name: "Tour",
  date: "1998-10-18",
  sourceLabel: "Calendar",
};
const candidateSource = { name: "Tour", date: "1998-10-18", sourceLabel: "Calendar" };
const eventGoal: PlanCreationAnswerInput = {
  kind: "goal",
  goal: { kind: "event-candidate", candidateId: eventCandidate.candidateId },
};
const fitnessGoal: PlanCreationAnswerInput = {
  kind: "goal",
  goal: { kind: "fitness", outcome: "Build power" },
};
const eventSuccess: PlanCreationAnswerInput = {
  kind: "success",
  success: { kind: "event-finish", choice: "finish-fast" },
};
const fitnessSuccess: PlanCreationAnswerInput = {
  kind: "success",
  success: { kind: "authored", text: "Ride strongly for four hours" },
};
const startTiming: PlanCreationAnswerInput = {
  kind: "start-timing",
  timing: { kind: "as-soon-as-possible" },
};
const fixedMode: PlanCreationAnswerInput = { kind: "schedule-mode", mode: "fixed" };
const flexibleMode: PlanCreationAnswerInput = { kind: "schedule-mode", mode: "flexible" };
const fixedAvailability: PlanCreationAnswerInput = {
  kind: "availability",
  mode: "fixed",
  weeklyHoursLimit: 8,
  longestWorkoutHours: 3,
  usableWeekdays: [6, 2, 4],
};
const flexibleAvailability: PlanCreationAnswerInput = {
  kind: "availability",
  mode: "flexible",
  weeklyHoursLimit: 8,
  longestWorkoutHours: 3,
};
const noCommitments: PlanCreationAnswerInput = {
  kind: "commitments",
  commitments: { kind: "none" },
};
const regularBaseline: PlanCreationAnswerInput = { kind: "baseline", baseline: "regular" };
const noRestriction: PlanCreationAnswerInput = {
  kind: "restriction",
  restriction: { kind: "none" },
};

const stored = (
  sequence: number,
  value: PlanCreationAnswerInput,
  source: { readonly kind: "athlete" } | { readonly kind: "derived"; readonly label: string } = {
    kind: "athlete",
  },
): PlanCreationAnswerRecord => ({
  id: id(`${sequence + 20}`),
  sequence,
  creationVersion: sequence + 1,
  answerKey: value.kind,
  valueJson: JSON.stringify({ answer: value, source }),
  confirmedAtMs: 883_612_800_000 + sequence,
});

const snapshot = (answers: readonly PlanCreationAnswerRecord[] = []): PlanCreationSnapshot => ({
  id: id("1"),
  status: "in-progress",
  version: answers.length + 1,
  seed: { schemaVersion: 1, eventCandidates: [eventCandidate] },
  createdAtMs: 883_612_800_000,
  updatedAtMs: 883_612_800_000 + answers.length,
  answers,
});

interface Harness {
  readonly host: ReturnType<typeof createPlanCreationOperations>;
  readonly recordAnswer: ReturnType<typeof vi.fn<PlanCreationRepository["recordAnswer"]>>;
  current(): PlanCreationSnapshot;
  submit(
    answer: PlanCreationAnswerInput,
    options?: { readonly commandId?: string; readonly expectedVersion?: number },
  ): Promise<PlanCreationAnswerRpcResult>;
}

function harness(
  initial: PlanCreationSnapshot = snapshot(),
  baselineEvidence: BaselineEvidenceSource = { read: async () => undefined },
): Harness {
  let current = initial;
  let identitySequence = 100;
  let commandSequence = 0;
  const commands = new Map<string, string>();
  const recordAnswer = vi.fn<PlanCreationRepository["recordAnswer"]>(async (input) => {
    const priorDigest = commands.get(input.command.commandId);
    if (priorDigest !== undefined) {
      if (priorDigest !== input.command.requestDigest) {
        throw new PlanCreationStoreError("command-conflict");
      }
      return { outcome: "replayed", snapshot: current };
    }
    if (current.id !== input.creationId) throw new PlanCreationStoreError("missing-creation");
    if (current.version !== input.expectedVersion)
      throw new PlanCreationStoreError("stale-version");
    const sequence = current.answers.length + 1;
    current = {
      ...current,
      version: current.version + 1,
      updatedAtMs: current.updatedAtMs + 1,
      answers: [
        ...current.answers,
        {
          id: input.answerId,
          sequence,
          creationVersion: current.version + 1,
          answerKey: input.answerKey,
          valueJson: input.valueJson,
          confirmedAtMs: input.command.nowMs,
        },
      ],
    };
    commands.set(input.command.commandId, input.command.requestDigest);
    return { outcome: "recorded", snapshot: current };
  });
  const repository: PlanCreationRepository = {
    readUnfinished: async () => current,
    start: async () => ({ outcome: "resumed", snapshot: current }),
    recordAnswer,
  };
  const host = createPlanCreationOperations({
    repository,
    identity: {
      deviceId: async () => "test-device",
      newUlid: () => id(`${++identitySequence}`),
      hlcStamp: () => ({ physicalMs: 883_612_800_000 + identitySequence, counter: 0 }),
    },
    crypto: globalThis.crypto,
    eventCandidates: { read: async () => [candidateSource] },
    baselineEvidence,
    today: () => today,
  });
  return {
    host,
    recordAnswer,
    current: () => current,
    submit: (answer, options = {}) =>
      host["plan_creation.answer"]({
        commandId: options.commandId ?? `command-${++commandSequence}`,
        creationId: current.id,
        expectedVersion: options.expectedVersion ?? current.version,
        answer,
      }),
  };
}

const answered = async (
  pending: Promise<PlanCreationAnswerRpcResult>,
): Promise<PlanCreationCardModel> => {
  const result = await pending;
  if (result.status !== "answered") throw new Error(`Expected answered, got ${result.reason}`);
  return result.planCreation;
};

const questionKind = (result: PlanCreationCardModel): string | null =>
  result.openQuestion?.kind ?? null;

describe("Plan Creation operations", () => {
  it("asks every Event Goal question in flow order and becomes ready", async () => {
    const test = harness();
    expect(questionKind(projectPlanCreationCard(test.current(), { today }))).toBe("goal-question");
    const answers = [
      eventGoal,
      eventSuccess,
      startTiming,
      fixedMode,
      fixedAvailability,
      noCommitments,
      regularBaseline,
      noRestriction,
    ];
    const expectedQuestions = [
      "success-question",
      "start-timing-question",
      "schedule-mode-question",
      "availability-question",
      "commitments-question",
      "baseline-question",
      "restriction-question",
      null,
    ];
    for (const [index, answer] of answers.entries()) {
      const model = await answered(test.submit(answer));
      expect(questionKind(model)).toBe(expectedQuestions[index]);
      expect(model.readiness).toBe(index === answers.length - 1 ? "ready" : "incomplete");
    }
    expect(test.current().answers.map((row) => row.answerKey)).not.toContain("plan-length");
    expect(await test.host.readCard()).toMatchObject({
      readiness: "ready",
      openQuestion: null,
      answeredSummaries: [
        { answerKey: "goal" },
        { answerKey: "success" },
        { answerKey: "start-timing" },
        { answerKey: "schedule-mode" },
        {
          answerKey: "availability",
          detail: "Up to 8 h a week, longest Workout 3 h, Tue Thu Sat",
        },
        { answerKey: "commitments" },
        { answerKey: "baseline" },
        { answerKey: "restriction", detail: "No training restrictions" },
      ],
    });
  });

  it("asks every Fitness Goal question in flow order and discloses the flexible pool", async () => {
    const evidence = vi.fn(async () => ({
      baseline: "regular" as const,
      label: "synced training history",
    }));
    const test = harness(snapshot(), { read: evidence });
    const answers = [
      fitnessGoal,
      fitnessSuccess,
      { kind: "plan-length", weeks: 12 } as const,
      startTiming,
      flexibleMode,
      flexibleAvailability,
      noCommitments,
      noRestriction,
    ];
    const expectedQuestions = [
      "success-question",
      "plan-length-question",
      "start-timing-question",
      "schedule-mode-question",
      "availability-question",
      "commitments-question",
      "restriction-question",
      null,
    ];
    for (const [index, answer] of answers.entries()) {
      const model = await answered(test.submit(answer));
      expect(questionKind(model)).toBe(expectedQuestions[index]);
      if (model.openQuestion?.kind === "availability-question") {
        expect(model.openQuestion).toMatchObject({
          mode: "flexible",
          derivedPoolNote: expect.stringContaining("3 Workouts up to 6 h"),
        });
      }
    }
    expect(evidence).toHaveBeenCalledOnce();
    expect(JSON.parse(test.current().answers.at(-2)?.valueJson ?? "null")).toEqual({
      answer: regularBaseline,
      source: { kind: "derived", label: "synced training history" },
    });
    expect(await test.host.readCard()).toMatchObject({
      readiness: "ready",
      answeredSummaries: [
        { answerKey: "goal" },
        { answerKey: "success" },
        { answerKey: "plan-length", detail: "12 weeks" },
        { answerKey: "start-timing" },
        { answerKey: "schedule-mode", detail: "Flexible Schedule" },
        {
          answerKey: "availability",
          detail: "Up to 8 h a week, longest Workout 3 h, 4 Workouts in the flexible pool",
        },
        { answerKey: "commitments" },
        { answerKey: "baseline" },
        { answerKey: "restriction" },
      ],
    });
  });

  it("accepts Edit for a valid earlier key, appends, and projects only its latest row", async () => {
    const test = harness();
    await answered(test.submit(fitnessGoal));
    await answered(test.submit(fitnessSuccess));
    await answered(test.submit({ kind: "plan-length", weeks: 8 }));
    const edited = await answered(test.submit({ kind: "plan-length", weeks: 16 }));
    expect(test.current().answers.map((row) => row.answerKey)).toEqual([
      "goal",
      "success",
      "plan-length",
      "plan-length",
    ]);
    expect(test.current().answers.at(-1)).toMatchObject({ sequence: 4, creationVersion: 5 });
    expect(
      edited.answeredSummaries.filter((summary) => summary.answerKey === "plan-length"),
    ).toMatchObject([{ answerKey: "plan-length", title: "Plan length", detail: "16 weeks" }]);
    expect(questionKind(edited)).toBe("start-timing-question");
  });

  it("invalidates success and Plan length only when the goal kind changes", async () => {
    const test = harness();
    await answered(test.submit(fitnessGoal));
    await answered(test.submit(fitnessSuccess));
    await answered(test.submit({ kind: "plan-length", weeks: 12 }));
    const sameKind = await answered(
      test.submit({ kind: "goal", goal: { kind: "fitness", outcome: "Build endurance" } }),
    );
    expect(sameKind.answeredSummaries.map((summary) => summary.answerKey)).toEqual([
      "goal",
      "success",
      "plan-length",
    ]);
    expect(questionKind(sameKind)).toBe("start-timing-question");

    const changedKind = await answered(
      test.submit({
        kind: "goal",
        goal: { kind: "event-manual", name: "Autumn ride", date: "1998-11-08" },
      }),
    );
    expect(changedKind.answeredSummaries.map((summary) => summary.answerKey)).toEqual(["goal"]);
    expect(questionKind(changedKind)).toBe("success-question");
    const reconfirmed = await answered(test.submit(eventSuccess));
    expect(reconfirmed.answeredSummaries.map((summary) => summary.answerKey)).toEqual([
      "goal",
      "success",
    ]);
    expect(questionKind(reconfirmed)).toBe("start-timing-question");
    const changedEventKind = await answered(test.submit(eventGoal));
    expect(changedEventKind.answeredSummaries.map((summary) => summary.answerKey)).toEqual([
      "goal",
    ]);
    expect(questionKind(changedEventKind)).toBe("success-question");
  });

  it("re-asks availability after Schedule mode changes and rejects a mismatched mode", async () => {
    const test = harness();
    for (const value of [
      fitnessGoal,
      fitnessSuccess,
      { kind: "plan-length", weeks: 8 } as const,
      startTiming,
      flexibleMode,
      flexibleAvailability,
    ]) {
      await answered(test.submit(value));
    }
    const changed = await answered(test.submit(fixedMode));
    expect(questionKind(changed)).toBe("availability-question");
    expect(changed.openQuestion).toMatchObject({ mode: "fixed" });
    expect(changed.answeredSummaries.map((summary) => summary.answerKey)).not.toContain(
      "availability",
    );
    await expect(test.submit(flexibleAvailability)).resolves.toMatchObject({
      status: "rejected",
      reason: "invalid-answer",
      planCreation: { openQuestion: { kind: "availability-question", mode: "fixed" } },
    });
    expect(test.current().answers).toHaveLength(7);
  });

  it("rejects Event Goal Plan length and other out-of-order keys", async () => {
    const test = harness();
    await expect(test.submit(fitnessSuccess)).resolves.toMatchObject({
      status: "rejected",
      reason: "answer-not-expected",
    });
    await answered(test.submit(eventGoal));
    expect(questionKind(await answered(test.submit(fitnessSuccess)))).toBe("start-timing-question");
    await expect(test.submit({ kind: "plan-length", weeks: 8 })).resolves.toMatchObject({
      status: "rejected",
      reason: "answer-not-expected",
      planCreation: { openQuestion: { kind: "start-timing-question" } },
    });
    expect(test.current().answers).toHaveLength(2);
  });

  it("rejects an earliest start before the host civil date", async () => {
    const test = harness();
    await answered(test.submit(eventGoal));
    await answered(test.submit(eventSuccess));
    await expect(
      test.submit({ kind: "start-timing", timing: { kind: "earliest", date: "1998-09-01" } }),
    ).resolves.toMatchObject({
      status: "rejected",
      reason: "invalid-answer",
      planCreation: {
        version: 3,
        openQuestion: { kind: "start-timing-question", earliestAllowed: today },
      },
    });
    expect(test.recordAnswer).toHaveBeenCalledTimes(2);
  });

  it("replays an identical answer result without appending another row", async () => {
    const test = harness();
    const request = {
      commandId: "replay",
      creationId: test.current().id,
      expectedVersion: 1,
      answer: fitnessGoal,
    };
    const first = await test.host["plan_creation.answer"](request);
    const replay = await test.host["plan_creation.answer"](request);
    expect(replay).toEqual(first);
    expect(test.current().answers).toHaveLength(1);
    expect(test.recordAnswer).toHaveBeenCalledTimes(2);
    await expect(
      test.host["plan_creation.answer"]({
        ...request,
        answer: { kind: "goal", goal: { kind: "fitness", outcome: "Build endurance" } },
      }),
    ).resolves.toMatchObject({ status: "rejected", reason: "command-conflict" });
    expect(test.current().answers).toHaveLength(1);
  });

  it("round-trips sourced answers and reads legacy raw answers as athlete-sourced", async () => {
    const test = harness();
    await answered(test.submit(fitnessGoal));
    const persisted = test.recordAnswer.mock.calls[0]?.[0].valueJson;
    expect(JSON.parse(persisted ?? "null")).toEqual({
      answer: fitnessGoal,
      source: { kind: "athlete" },
    });
    expect(projectPlanCreationCard(test.current(), { today })).toMatchObject({
      answeredSummaries: [{ answerKey: "goal", detail: "Build power" }],
    });
    const legacy = snapshot([
      {
        ...stored(1, fitnessGoal),
        valueJson: JSON.stringify(fitnessGoal),
      },
    ]);
    expect(projectPlanCreationCard(legacy, { today })).toMatchObject({
      answeredSummaries: [{ answerKey: "goal", answer: fitnessGoal }],
    });
    expect(readPlanCreationAnswers(legacy)[0]?.source).toEqual({ kind: "athlete" });
  });

  it.each([
    [6, 3],
    [8, 4],
    [8.5, 5],
  ])("derives a %s-hour flexible week as a %s-Workout pool", (weeklyHoursLimit, poolSize) => {
    const answers: PlanCreationAnswerInput[] = [
      fitnessGoal,
      fitnessSuccess,
      { kind: "plan-length", weeks: 8 },
      startTiming,
      flexibleMode,
      {
        kind: "availability",
        mode: "flexible",
        weeklyHoursLimit,
        longestWorkoutHours: 2,
      },
    ];
    const projected = projectPlanCreationCard(
      snapshot(answers.map((value, index) => stored(index + 1, value))),
      {
        today,
      },
    );
    expect(projected.answeredSummaries.at(-1)?.detail).toContain(
      `${poolSize} Workouts in the flexible pool`,
    );
  });

  it("maps start outcomes, invalid event candidates, stale versions, and command conflicts", async () => {
    let current: PlanCreationSnapshot | undefined;
    let call = 0;
    const outcomes = ["created", "resumed", "replayed"] as const;
    const start = vi.fn<PlanCreationRepository["start"]>(async (input) => {
      if (input.command.commandId === "conflict") {
        throw new PlanCreationStoreError("command-conflict");
      }
      current ??= snapshot();
      return { outcome: outcomes[call++] ?? "replayed", snapshot: current };
    });
    let sequence = 8;
    const host = createPlanCreationOperations({
      repository: {
        readUnfinished: async () => current,
        start,
        recordAnswer: async () => {
          throw new PlanCreationStoreError("stale-version");
        },
      },
      identity: {
        deviceId: async () => "test-device",
        newUlid: () => id(`${++sequence}`),
        hlcStamp: () => ({ physicalMs: 883_612_800_000, counter: 0 }),
      },
      crypto: globalThis.crypto,
      eventCandidates: { read: async () => [candidateSource] },
      today: () => today,
    });
    await expect(host["plan_creation.start"]({ commandId: "one" })).resolves.toMatchObject({
      outcome: "created",
    });
    await expect(host["plan_creation.start"]({ commandId: "two" })).resolves.toMatchObject({
      outcome: "resumed",
    });
    await expect(host["plan_creation.start"]({ commandId: "three" })).resolves.toMatchObject({
      outcome: "resumed",
    });
    await expect(host["plan_creation.start"]({ commandId: "conflict" })).resolves.toEqual({
      status: "rejected",
      reason: "command-conflict",
    });
    expect(start.mock.calls[0]?.[0].seed.eventCandidates).toEqual([
      { candidateId: id("9"), ...candidateSource },
    ]);
    await expect(
      host["plan_creation.answer"]({
        commandId: "candidate",
        creationId: id("1"),
        expectedVersion: 1,
        answer: { kind: "goal", goal: { kind: "event-candidate", candidateId: id("7") } },
      }),
    ).resolves.toMatchObject({ reason: "invalid-answer" });
    await expect(
      host["plan_creation.answer"]({
        commandId: "stale",
        creationId: id("1"),
        expectedVersion: 2,
        answer: fitnessGoal,
      }),
    ).resolves.toMatchObject({ reason: "stale-version" });
  });

  it("projects only valid latest answers in flow order", () => {
    const answers = [
      stored(1, fitnessGoal),
      stored(2, fitnessSuccess),
      stored(3, { kind: "plan-length", weeks: 8 }),
      stored(4, startTiming),
      stored(5, flexibleMode),
      stored(6, flexibleAvailability),
      stored(7, fixedMode),
    ];
    const current = snapshot(answers);
    expect(expectedPlanCreationAnswerKind(current)).toBe("availability");
    expect(projectPlanCreationCard(current, { today })).toMatchObject({
      readiness: "incomplete",
      answeredSummaries: [
        { answerKey: "goal" },
        { answerKey: "success" },
        { answerKey: "plan-length" },
        { answerKey: "start-timing" },
        { answerKey: "schedule-mode", detail: "Fixed Schedule" },
      ],
      openQuestion: { kind: "availability-question", mode: "fixed" },
    });
    expect(
      PlanCreationCardModelSchema.parse(projectPlanCreationCard(current, { today })),
    ).toBeTruthy();
  });
});
