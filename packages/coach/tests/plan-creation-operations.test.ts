import { createHash } from "node:crypto";
import { canonicalJson } from "@enduragent/kernel/archive";
import { describe, expect, it, vi, onTestFinished } from "vitest";
import {
  PlanCreationCardModelSchema,
  type PlanCreationAnswerInput,
  type PlanCreationAnswerRpcResult,
  type PlanCreationCardModel,
} from "@enduragent/coach-contract";
import {
  createPlanCreationRepository,
  createPlanRepository,
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
import { runMigrations } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { openSqliteStorage } from "@enduragent/kernel-node/sqlite";
import { createPlanningReadService } from "../src/planning-read-service.js";
import { readPlanCreationAnswers } from "../src/plan-creation-answers.js";

const unusedStore = () => {
  const store = openSqliteStorage(":memory:");
  onTestFinished(() => store.close());
  return store;
};

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
  goal: { kind: "fitness" },
};
const eventSuccess: PlanCreationAnswerInput = {
  kind: "success",
  success: { kind: "event-finish", choice: "finish-fast" },
};
const fitnessSuccess: PlanCreationAnswerInput = {
  kind: "success",
  success: { kind: "fitness-choice", choice: "climb-stronger" },
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
  currentDraft: null,
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
    activate: async () => {
      throw new Error("unused");
    },
    replayDraft: async () => undefined,
    recordDraft: async () => {
      throw new Error("unused");
    },
    readUnfinished: async () => current,
    start: async () => ({ outcome: "resumed", snapshot: current }),
    recordAnswer,
    discard: async () => {
      throw new Error("unused");
    },
  };
  const host = createPlanCreationOperations({
    store: unusedStore(),
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
    expect(projectPlanCreationCard(test.current(), { today }).openQuestion).toMatchObject({
      kind: "goal-question",
      step: { current: 1, total: 9 },
      authoredOption: { detail: "Answer in your own words." },
    });
    const answers = [
      eventGoal,
      fixedMode,
      fixedAvailability,
      startTiming,
      noCommitments,
      regularBaseline,
      eventSuccess,
      noRestriction,
    ];
    const expectedQuestions = [
      "schedule-mode-question",
      "availability-question",
      "start-timing-question",
      "commitments-question",
      "baseline-question",
      "success-question",
      "restriction-question",
      null,
    ];
    for (const [index, answer] of answers.entries()) {
      const model = await answered(test.submit(answer));
      expect(questionKind(model)).toBe(expectedQuestions[index]);
      expect(model.readiness).toBe(index === answers.length - 1 ? "ready" : "incomplete");
      if (index === 0) expect(model.openQuestion?.step.total).toBe(8);
    }
    expect(test.current().answers.map((row) => row.answerKey)).not.toContain("plan-length");
    expect(await test.host.readCard()).toMatchObject({
      readiness: "ready",
      openQuestion: null,
      answeredSummaries: [
        { answerKey: "goal" },
        { answerKey: "schedule-mode" },
        {
          answerKey: "availability",
          detail: "Up to 8 h a week, longest Workout 3 h, Tue Thu Sat",
        },
        { answerKey: "start-timing" },
        { answerKey: "commitments" },
        { answerKey: "baseline" },
        { answerKey: "success" },
        { answerKey: "restriction", detail: "No training restrictions" },
      ],
    });
  });

  it("accepts every Training Restriction shape and projects its optional end date", async () => {
    const priorAnswers = [
      eventGoal,
      fixedMode,
      fixedAvailability,
      startTiming,
      noCommitments,
      regularBaseline,
      eventSuccess,
    ];
    const cases: readonly [PlanCreationAnswerInput, string][] = [
      [noRestriction, "No training restrictions"],
      [{ kind: "restriction", restriction: { kind: "no-training" } }, "No training"],
      [
        {
          kind: "restriction",
          restriction: { kind: "no-training", endDate: "1998-09-14" },
        },
        "No training until 1998-09-14",
      ],
      [{ kind: "restriction", restriction: { kind: "no-hard-training" } }, "No hard training"],
      [
        {
          kind: "restriction",
          restriction: { kind: "no-hard-training", endDate: "1998-09-14" },
        },
        "No hard training until 1998-09-14",
      ],
      [
        { kind: "restriction", restriction: { kind: "max-duration", hours: 1.5 } },
        "Maximum Workout duration 1.5 h",
      ],
      [
        {
          kind: "restriction",
          restriction: { kind: "max-duration", hours: 1.5, endDate: "1998-09-14" },
        },
        "Maximum Workout duration 1.5 h until 1998-09-14",
      ],
    ];
    for (const [answer, detail] of cases) {
      const test = harness(snapshot(priorAnswers.map((value, index) => stored(index + 1, value))));
      const model = await answered(test.submit(answer));
      expect(model).toMatchObject({
        readiness: "ready",
        openQuestion: null,
        answeredSummaries: expect.arrayContaining([
          expect.objectContaining({ answerKey: "restriction", detail, answer }),
        ]),
      });
    }
  });

  it("asks every Fitness Goal question in flow order and discloses the flexible pool", async () => {
    const evidence = vi.fn(async () => ({
      baseline: "regular" as const,
      label: "synced training history",
    }));
    const test = harness(snapshot(), { read: evidence });
    const answers = [
      fitnessGoal,
      { kind: "plan-length", weeks: 12 } as const,
      flexibleMode,
      flexibleAvailability,
      startTiming,
      noCommitments,
      fitnessSuccess,
      noRestriction,
    ];
    const expectedQuestions = [
      "plan-length-question",
      "schedule-mode-question",
      "availability-question",
      "start-timing-question",
      "commitments-question",
      "success-question",
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
          weeklyHoursOptions: [
            { detail: "Up to about six hours of riding a week." },
            { detail: "Up to about eight hours of riding a week." },
            { detail: "About nine hours or more of riding a week." },
          ],
        });
      }
    }
    expect(evidence).toHaveBeenCalledOnce();
    expect(
      JSON.parse(
        test.current().answers.find((answer) => answer.answerKey === "baseline")?.valueJson ??
          "null",
      ),
    ).toEqual({
      answer: regularBaseline,
      source: { kind: "derived", label: "synced training history" },
    });
    expect(await test.host.readCard()).toMatchObject({
      readiness: "ready",
      answeredSummaries: [
        { answerKey: "goal" },
        { answerKey: "plan-length", detail: "12 weeks" },
        { answerKey: "schedule-mode", detail: "Flexible Schedule" },
        {
          answerKey: "availability",
          detail: "Up to 8 h a week, longest Workout 3 h, 4 Workouts in the flexible pool",
        },
        { answerKey: "start-timing" },
        { answerKey: "commitments" },
        { answerKey: "baseline" },
        { answerKey: "success" },
        { answerKey: "restriction" },
      ],
    });
  });

  it("accepts Edit for a valid earlier key, appends, and projects only its latest row", async () => {
    const test = harness();
    await answered(test.submit(fitnessGoal));
    await answered(test.submit({ kind: "plan-length", weeks: 8 }));
    const edited = await answered(test.submit({ kind: "plan-length", weeks: 16 }));
    expect(test.current().answers.map((row) => row.answerKey)).toEqual([
      "goal",
      "plan-length",
      "plan-length",
    ]);
    expect(test.current().answers.at(-1)).toMatchObject({ sequence: 3, creationVersion: 4 });
    expect(
      edited.answeredSummaries.filter((summary) => summary.answerKey === "plan-length"),
    ).toMatchObject([{ answerKey: "plan-length", title: "Plan length", detail: "16 weeks" }]);
    expect(questionKind(edited)).toBe("schedule-mode-question");
  });

  it("invalidates success and Plan length only when the goal kind changes", async () => {
    const test = harness();
    for (const answer of [
      fitnessGoal,
      { kind: "plan-length", weeks: 12 } as const,
      fixedMode,
      fixedAvailability,
      startTiming,
      noCommitments,
      regularBaseline,
      fitnessSuccess,
    ]) {
      await answered(test.submit(answer));
    }
    const sameKind = await answered(
      test.submit({ kind: "goal", goal: { kind: "fitness", outcome: "Build endurance" } }),
    );
    expect(sameKind.answeredSummaries.map((summary) => summary.answerKey)).toEqual([
      "goal",
      "plan-length",
      "schedule-mode",
      "availability",
      "start-timing",
      "commitments",
      "baseline",
      "success",
    ]);
    expect(questionKind(sameKind)).toBe("restriction-question");

    const changedKind = await answered(
      test.submit({
        kind: "goal",
        goal: { kind: "event-manual", name: "Autumn ride", date: "1998-11-08" },
      }),
    );
    expect(changedKind.answeredSummaries.map((summary) => summary.answerKey)).toEqual([
      "goal",
      "schedule-mode",
      "availability",
      "start-timing",
      "commitments",
      "baseline",
    ]);
    expect(questionKind(changedKind)).toBe("success-question");
    const reconfirmed = await answered(test.submit(eventSuccess));
    expect(reconfirmed.answeredSummaries.map((summary) => summary.answerKey)).toEqual([
      "goal",
      "schedule-mode",
      "availability",
      "start-timing",
      "commitments",
      "baseline",
      "success",
    ]);
    expect(questionKind(reconfirmed)).toBe("restriction-question");
    const changedEventKind = await answered(test.submit(eventGoal));
    expect(changedEventKind.answeredSummaries.map((summary) => summary.answerKey)).toEqual([
      "goal",
      "schedule-mode",
      "availability",
      "start-timing",
      "commitments",
      "baseline",
      "success",
    ]);
    expect(questionKind(changedEventKind)).toBe("restriction-question");
  });

  it("re-asks availability across a Schedule mode flip away and back", async () => {
    const test = harness();
    for (const value of [
      fitnessGoal,
      { kind: "plan-length", weeks: 8 } as const,
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
    expect(test.current().answers).toHaveLength(5);
    await answered(test.submit(fixedAvailability));
    expect(questionKind(await answered(test.submit(flexibleMode)))).toBe("availability-question");
    const flippedBack = await answered(test.submit(fixedMode));
    expect(questionKind(flippedBack)).toBe("availability-question");
    expect(flippedBack.answeredSummaries.map((summary) => summary.answerKey)).not.toContain(
      "availability",
    );
  });

  it("rejects Event Goal Plan length and other out-of-order keys", async () => {
    const test = harness();
    await expect(test.submit(fitnessSuccess)).resolves.toMatchObject({
      status: "rejected",
      reason: "answer-not-expected",
    });
    await answered(test.submit(eventGoal));
    await expect(test.submit({ kind: "plan-length", weeks: 8 })).resolves.toMatchObject({
      status: "rejected",
      reason: "answer-not-expected",
      planCreation: { openQuestion: { kind: "schedule-mode-question" } },
    });
    for (const answer of [
      fixedMode,
      fixedAvailability,
      startTiming,
      noCommitments,
      regularBaseline,
    ]) {
      await answered(test.submit(answer));
    }
    await expect(test.submit(fitnessSuccess)).resolves.toMatchObject({
      status: "rejected",
      reason: "invalid-answer",
      planCreation: { openQuestion: { kind: "success-question" } },
    });
    expect(test.current().answers).toHaveLength(6);
  });

  it("rejects an earliest start before the host civil date", async () => {
    const test = harness();
    await answered(test.submit(eventGoal));
    await answered(test.submit(fixedMode));
    await answered(test.submit(fixedAvailability));
    await expect(
      test.submit({ kind: "start-timing", timing: { kind: "earliest", date: "1998-09-01" } }),
    ).resolves.toMatchObject({
      status: "rejected",
      reason: "invalid-answer",
      planCreation: {
        version: 4,
        openQuestion: { kind: "start-timing-question", earliestAllowed: today },
      },
    });
    expect(test.recordAnswer).toHaveBeenCalledTimes(3);
  });

  it("rejects a Training Restriction end date before the host civil date", async () => {
    const priorAnswers = [
      eventGoal,
      fixedMode,
      fixedAvailability,
      startTiming,
      noCommitments,
      regularBaseline,
      eventSuccess,
    ];
    const test = harness(snapshot(priorAnswers.map((answer, index) => stored(index + 1, answer))));

    await expect(
      test.submit({
        kind: "restriction",
        restriction: { kind: "no-hard-training", endDate: "1998-09-01" },
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      reason: "invalid-answer",
      planCreation: { version: 8, openQuestion: { kind: "restriction-question" } },
    });
    expect(test.recordAnswer).not.toHaveBeenCalled();
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
      answeredSummaries: [
        { answerKey: "goal", detail: "Build fitness for a fixed number of weeks." },
      ],
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
      { kind: "plan-length", weeks: 8 },
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
      store: unusedStore(),
      repository: {
        activate: async () => {
          throw new Error("unused");
        },
        replayDraft: async () => undefined,
        recordDraft: async () => {
          throw new Error("unused");
        },
        readUnfinished: async () => current,
        start,
        recordAnswer: async () => {
          throw new PlanCreationStoreError("stale-version");
        },
        discard: async () => {
          throw new Error("unused");
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
      stored(2, { kind: "plan-length", weeks: 8 }),
      stored(3, flexibleMode),
      stored(4, flexibleAvailability),
      stored(5, startTiming),
      stored(6, fitnessSuccess),
      stored(7, fixedMode),
    ];
    const current = snapshot(answers);
    expect(expectedPlanCreationAnswerKind(current)).toBe("availability");
    expect(projectPlanCreationCard(current, { today })).toMatchObject({
      readiness: "incomplete",
      answeredSummaries: [
        { answerKey: "goal" },
        { answerKey: "plan-length" },
        { answerKey: "schedule-mode", detail: "Fixed Schedule" },
        { answerKey: "start-timing" },
        { answerKey: "success", detail: "Climb stronger" },
      ],
      openQuestion: { kind: "availability-question", mode: "fixed" },
    });
    expect(
      PlanCreationCardModelSchema.parse(projectPlanCreationCard(current, { today })),
    ).toBeTruthy();
  });

  it("maps every discard outcome and projects the current Card on rejection", async () => {
    let current: PlanCreationSnapshot | undefined = snapshot();
    let discardError: PlanCreationStoreError | Error | undefined;
    const readUnfinished = vi.fn(async () => current);
    const discard = vi.fn<PlanCreationRepository["discard"]>(async () => {
      if (discardError !== undefined) throw discardError;
      current = undefined;
      return { outcome: "discarded" };
    });
    const host = createPlanCreationOperations({
      store: unusedStore(),
      repository: {
        activate: async () => {
          throw new Error("unused");
        },
        replayDraft: async () => undefined,
        recordDraft: async () => {
          throw new Error("unused");
        },
        readUnfinished,
        start: async () => {
          throw new Error("unused");
        },
        recordAnswer: async () => {
          throw new Error("unused");
        },
        discard,
      },
      identity: {
        deviceId: async () => "test-device",
        newUlid: () => id("9"),
        hlcStamp: () => ({ physicalMs: 883_612_800_000, counter: 0 }),
      },
      crypto: globalThis.crypto,
      eventCandidates: { read: async () => [] },
      today: () => today,
    });
    const request = { commandId: "discard", creationId: id("1"), expectedVersion: 1 };

    await expect(host["plan_creation.discard"](request)).resolves.toEqual({
      status: "discarded",
    });
    expect(readUnfinished).not.toHaveBeenCalled();
    expect(discard).toHaveBeenCalledWith({
      command: {
        commandId: "discard",
        requestDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
        nowMs: 883_612_800_000,
        deviceId: "test-device",
        hlcPhysicalMs: 883_612_800_000,
        hlcCounter: 0,
      },
      creationId: id("1"),
      expectedVersion: 1,
    });
    await expect(host.readCard()).resolves.toBeNull();

    readUnfinished.mockClear();
    await expect(host["plan_creation.discard"](request)).resolves.toEqual({
      status: "discarded",
    });
    expect(readUnfinished).not.toHaveBeenCalled();

    current = snapshot([stored(1, fitnessGoal)]);
    discardError = new PlanCreationStoreError("stale-version");
    await expect(host["plan_creation.discard"](request)).resolves.toMatchObject({
      status: "rejected",
      reason: "stale-version",
      planCreation: { creationId: id("1"), version: 2 },
    });

    discardError = new PlanCreationStoreError("command-conflict");
    await expect(host["plan_creation.discard"](request)).resolves.toMatchObject({
      status: "rejected",
      reason: "command-conflict",
      planCreation: { creationId: id("1"), version: 2 },
    });

    discardError = new PlanCreationStoreError("no-unfinished-creation");
    current = { ...snapshot(), id: id("7") };
    await expect(host["plan_creation.discard"](request)).resolves.toMatchObject({
      status: "rejected",
      reason: "no-unfinished-creation",
      planCreation: { creationId: id("7"), version: 1 },
    });

    current = undefined;
    await expect(host["plan_creation.discard"](request)).resolves.toEqual({
      status: "rejected",
      reason: "no-unfinished-creation",
      planCreation: null,
    });

    discardError = new Error("unexpected");
    await expect(host["plan_creation.discard"](request)).rejects.toThrow("unexpected");
  });
});

async function previewHarness() {
  let currentToday = today;
  const store = openSqliteStorage(":memory:");
  onTestFinished(() => store.close());
  await runMigrations(store, MIGRATIONS);
  const repository = createPlanCreationRepository(store);
  let sequence = 100;
  const host = createPlanCreationOperations({
    store,
    repository,
    identity: {
      deviceId: async () => "preview-test-device",
      newUlid: () => id(`${++sequence}`),
      hlcStamp: () => ({ physicalMs: 883_612_800_000, counter: 0 }),
    },
    crypto: globalThis.crypto,
    eventCandidates: { read: async () => [candidateSource] },
    today: () => currentToday,
    todayDateKey: () => Number(currentToday.replaceAll("-", "")),
    now: () => Date.parse(`${currentToday}T12:00:00Z`),
  });
  const started = await host["plan_creation.start"]({ commandId: "start" });
  if (started.status !== "started") throw new Error("Expected creation");
  let card = started.planCreation;
  const answer = async (value: PlanCreationAnswerInput) => {
    card = await answered(
      host["plan_creation.answer"]({
        commandId: `answer-${++sequence}`,
        creationId: card.creationId,
        expectedVersion: card.version,
        answer: value,
      }),
    );
    return card;
  };
  const ready = async (mode: "fixed" | "flexible" = "flexible") => {
    for (const value of [
      fitnessGoal,
      { kind: "plan-length", weeks: 4 } as const,
      mode === "fixed" ? fixedMode : flexibleMode,
      mode === "fixed" ? fixedAvailability : flexibleAvailability,
      startTiming,
      noCommitments,
      regularBaseline,
      fitnessSuccess,
      noRestriction,
    ])
      await answer(value);
    return card;
  };
  return {
    store,
    repository,
    host,
    ready,
    answer,
    card: () => card,
    setToday: (value: string) => {
      currentToday = value;
    },
    advanceDay: () => {
      currentToday = "1998-09-03";
    },
  };
}

describe("Plan Creation preview", () => {
  it("stores a complete Draft, replays its result, and rebuilds stale review answers", async () => {
    const test = await previewHarness();
    const card = await test.ready();
    const request = {
      commandId: "preview",
      creationId: card.creationId,
      expectedVersion: card.version,
    };
    const first = await test.host["plan_creation.preview"](request);
    expect(first).toMatchObject({
      status: "previewed",
      planCreation: {
        status: "review",
        version: card.version + 1,
        draftStale: false,
        draft: { mode: "flexible", weeks: expect.any(Array), ftp: null },
      },
    });
    if (first.status !== "previewed" || first.planCreation.draft === null)
      throw new Error("Expected Draft");
    const draft = first.planCreation.draft;
    expect(draft.answeredSummaries).toEqual(card.answeredSummaries);
    expect(draft.answeredSummaries).toEqual(first.planCreation.answeredSummaries);
    const { inputFingerprint, outputFingerprint, ...output } = draft;
    expect(outputFingerprint).toBe(
      createHash("sha256").update(canonicalJson(output)).digest("hex"),
    );
    const snapshot = await test.repository.readUnfinished();
    expect(snapshot?.currentDraft?.outputSnapshotJson).toBe(canonicalJson(draft));
    expect(snapshot?.currentDraft?.activationFingerprint).toBe(outputFingerprint);
    expect(inputFingerprint).toBe(
      createHash("sha256")
        .update(snapshot?.currentDraft?.inputSnapshotJson ?? "")
        .digest("hex"),
    );
    expect(snapshot?.currentDraft?.inputFingerprint).toMatch(/^[0-9a-f]{64}$/u);
    const before = await test.store.all("SELECT * FROM plan_creation_draft_revision");
    const edited = await answered(
      test.host["plan_creation.answer"]({
        commandId: "edit",
        creationId: card.creationId,
        expectedVersion: card.version + 1,
        answer: { kind: "plan-length", weeks: 8 },
      }),
    );
    expect(edited).toMatchObject({ status: "review", draftStale: true });
    expect(
      edited.answeredSummaries.find((summary) => summary.answerKey === "plan-length")?.answer,
    ).toEqual({ kind: "plan-length", weeks: 8 });
    expect(
      edited.draft?.answeredSummaries.find((summary) => summary.answerKey === "plan-length")
        ?.answer,
    ).toEqual({ kind: "plan-length", weeks: 4 });
    expect(edited.draft).toEqual(draft);
    test.advanceDay();
    const reloaded = await test.host.readCard();
    expect(reloaded?.draft).toEqual(draft);
    expect(reloaded?.draftStale).toBe(true);
    expect(await test.host["plan_creation.preview"](request)).toEqual(first);
    expect(await test.store.all("SELECT * FROM plan_creation_draft_revision")).toEqual(before);
    await expect(
      test.host["plan_creation.preview"]({ ...request, expectedVersion: edited.version }),
    ).resolves.toMatchObject({ status: "rejected", reason: "command-conflict" });
    const rebuilt = await test.host["plan_creation.preview"]({
      ...request,
      commandId: "rebuild",
      expectedVersion: edited.version,
    });
    expect(rebuilt).toMatchObject({ status: "previewed", planCreation: { draftStale: false } });
    const stored = await test.repository.readUnfinished();
    expect(stored?.currentDraft).toMatchObject({ revisionNumber: 2, parentRevisionNumber: 1 });
    expect(await test.host.readCard()).toEqual(
      rebuilt.status === "previewed" ? rebuilt.planCreation : null,
    );
    expect(await test.store.all("SELECT * FROM plan")).toEqual([]);
    expect(await test.store.all("SELECT * FROM plan_conversation")).toEqual([]);
  });

  it("rejects incomplete, stale, and missing creations without storing a revision", async () => {
    const test = await previewHarness();
    const card = test.card();
    const request = {
      commandId: "preview",
      creationId: card.creationId,
      expectedVersion: card.version,
    };
    await expect(test.host["plan_creation.preview"](request)).resolves.toMatchObject({
      reason: "not-ready",
    });
    await expect(
      test.host["plan_creation.preview"]({ ...request, expectedVersion: 10 }),
    ).resolves.toMatchObject({ reason: "stale-version" });
    await expect(
      test.host["plan_creation.preview"]({ ...request, creationId: id("999") }),
    ).resolves.toMatchObject({ reason: "no-unfinished-creation" });
    await test.host["plan_creation.discard"]({ ...request, commandId: "discard" });
    await expect(test.host["plan_creation.preview"](request)).resolves.toMatchObject({
      reason: "no-unfinished-creation",
      planCreation: null,
    });
    expect(await test.store.all("SELECT * FROM plan_creation_draft_revision")).toEqual([]);
  });

  it("preserves the prior complete Draft when no Workouts fit", async () => {
    const test = await previewHarness();
    const card = await test.ready();
    const request = {
      commandId: "preview",
      creationId: card.creationId,
      expectedVersion: card.version,
    };
    await test.host["plan_creation.preview"](request);
    const before = await test.store.all("SELECT * FROM plan_creation_draft_revision");
    const edited = await answered(
      test.host["plan_creation.answer"]({
        commandId: "restrict",
        creationId: card.creationId,
        expectedVersion: card.version + 1,
        answer: { kind: "restriction", restriction: { kind: "no-training" } },
      }),
    );
    await expect(
      test.host["plan_creation.preview"]({
        ...request,
        commandId: "empty",
        expectedVersion: edited.version,
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      reason: "no-workouts",
      explanation: expect.stringContaining("No Workouts"),
      planCreation: { draftStale: true },
    });
    expect(await test.store.all("SELECT * FROM plan_creation_draft_revision")).toEqual(before);
    expect((await test.repository.readUnfinished())?.version).toBe(edited.version);
  });

  it("replays a successful preview after discard without reviving the creation", async () => {
    const test = await previewHarness();
    const card = await test.ready();
    const request = {
      commandId: "preview",
      creationId: card.creationId,
      expectedVersion: card.version,
    };
    const first = await test.host["plan_creation.preview"](request);
    await test.host["plan_creation.discard"]({
      ...request,
      commandId: "discard",
      expectedVersion: card.version + 1,
    });
    test.advanceDay();
    await expect(test.host["plan_creation.preview"](request)).resolves.toEqual(first);
    await expect(test.host.readCard()).resolves.toBeNull();
  });
});

describe("Plan Creation activation", () => {
  const review = async (mode: "fixed" | "flexible" = "fixed") => {
    const test = await previewHarness();
    const card = await test.ready(mode);
    const result = await test.host["plan_creation.preview"]({
      commandId: "preview",
      creationId: card.creationId,
      expectedVersion: card.version,
    });
    if (result.status !== "previewed" || result.planCreation.draft === null)
      throw new Error("Expected current Draft");
    return {
      ...test,
      draft: result.planCreation.draft,
      request: {
        commandId: "activate",
        creationId: card.creationId,
        expectedVersion: result.planCreation.version,
      },
    };
  };

  it("reads one snapshot while replacing the active Plan", async () => {
    const test = await review();
    const incumbentId = id("800");
    await createPlanRepository(test.store).replace({
      id: incumbentId,
      originId: null,
      name: "Earlier Plan",
      primaryGoal: "Build fitness",
      startDateKey: 19971222,
      targetDateKey: 19980118,
      status: "active",
      kind: "short_race_preparation",
      totalWeeks: 4,
      weekStartDay: 1,
      structureJson: "{}",
      createdAtMs: 882_748_800_000,
      updatedAtMs: 882_748_800_000,
      deviceId: "test-device",
      hlcPhysicalMs: 882_748_800_000,
      hlcCounter: 0,
    }, []);
    await test.store.run(
      `INSERT INTO planning_plan
(plan_id,status,version,current_revision_number,activated_at_ms,updated_at_ms,device_id,hlc_physical_ms,hlc_counter)
VALUES (?,'active',1,1,882748800000,882748800000,'test-device',882748800000,0)`,
      [incumbentId],
    );
    const transaction = vi.spyOn(test.store, "transaction");
    const readUnfinished = test.repository.readUnfinished.bind(test.repository);
    let signalEntered = () => {};
    let releaseRead = () => {};
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const reader = vi.spyOn(test.repository, "readUnfinished").mockImplementationOnce(async () => {
      const creation = await readUnfinished();
      signalEntered();
      await released;
      return creation;
    });
    test.setToday("1998-01-01");
    const before = test.host["plan.list"]({});
    await entered;
    expect(transaction).toHaveBeenCalledTimes(1);
    const activation = test.host["plan_creation.activate"](test.request);
    await vi.waitFor(() => expect(transaction).toHaveBeenCalledTimes(2));
    releaseRead();
    await expect(before).resolves.toMatchObject({
      creation: { creationId: test.request.creationId, status: "review" },
      active: { planId: incumbentId, start: "1997-12-22", end: "1998-01-18", creationId: null },
      closed: [],
      changes: [],
    });
    const activated = await activation;
    reader.mockRestore();
    transaction.mockClear();
    const after = await test.host["plan.list"]({});
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(after).toEqual({
      creation: null,
      changes: [],
      active: {
        planId: activated.planId,
        version: 1,
        name: "Improve fitness",
        start: test.draft.start,
        end: test.draft.end,
        weeks: 4,
        status: "active",
        closeReason: null,
        closedAt: null,
        activatedAt: "1998-01-01",
        creationId: test.request.creationId,
      },
      closed: [{
        planId: incumbentId,
        version: 2,
        name: "Earlier Plan",
        start: "1997-12-22",
        end: "1998-01-18",
        weeks: 4,
        status: "closed",
        closeReason: "stopped",
        closedAt: "1998-01-01",
        activatedAt: "1997-12-22",
        creationId: null,
      }],
    });
  });

  it("exposes the active version for closure and rejects a stale version", async () => {
    const test = await review();
    const activated = await test.host["plan_creation.activate"](test.request);
    const { active } = await test.host["plan.list"]({});
    expect(active).toMatchObject({ planId: activated.planId, version: 1 });
    if (active === null) throw new Error("Expected an active Plan");

    await expect(
      test.host["plan.close"]({
        commandId: "stop-stale",
        planId: active.planId,
        expectedVersion: active.version + 1,
      }),
    ).resolves.toEqual({ status: "rejected", reason: "stale-version" });
    await expect(
      test.host["plan.close"]({
        commandId: "stop-current",
        planId: active.planId,
        expectedVersion: active.version,
      }),
    ).resolves.toMatchObject({ status: "closed", planId: active.planId });
    await expect(test.host["plan.list"]({})).resolves.toMatchObject({
      active: null,
      closed: [{ planId: active.planId, version: active.version + 1 }],
    });
  });

  it("closes offline, replays the command, and reads the final snapshot", async () => {
    const test = await review("flexible");
    const activated = await test.host["plan_creation.activate"](test.request);
    await expect(test.host["plan.history"]({ planId: activated.planId })).resolves.toBeNull();
    const request = { commandId: "stop", planId: activated.planId, expectedVersion: 1 };
    const result = await test.host["plan.close"](request);
    expect(result).toMatchObject({ status: "closed", planId: activated.planId });
    await expect(test.host["plan.close"](request)).resolves.toEqual(result);
    await expect(test.host["plan.close"]({ ...request, expectedVersion: 2 })).resolves.toEqual({ status: "rejected", reason: "command-conflict" });
    const detail = await test.host["plan.history"]({ planId: activated.planId });
    expect(detail).toMatchObject({
      plan: { planId: activated.planId, status: "closed", closeReason: "stopped" },
      closeActor: "athlete",
      revision: { revisionNumber: 1, snapshot: test.draft },
      cleanup: "pending",
    });
    expect(detail?.revision.snapshot.weeks.flatMap((week) => week.workouts)).toEqual(
      expect.arrayContaining([expect.objectContaining({ date: null })]),
    );
    await expect(test.host["plan.list"]({})).resolves.toMatchObject({
      active: null,
      closed: [detail?.plan],
    });
    await expect(test.host["plan.history"]({ planId: id("999") })).resolves.toBeNull();
  });

  it("returns closure rejection reasons without changing an active Plan", async () => {
    const test = await review();
    const activated = await test.host["plan_creation.activate"](test.request);
    await expect(
      test.host["plan.close"]({ commandId: "stale", planId: activated.planId, expectedVersion: 2 }),
    ).resolves.toEqual({ status: "rejected", reason: "stale-version" });
    await expect(
      test.host["plan.close"]({ commandId: "missing", planId: id("999"), expectedVersion: 1 }),
    ).resolves.toEqual({ status: "rejected", reason: "no-active-plan" });
    expect((await test.host["plan.list"]({})).active?.planId).toBe(activated.planId);
  });

  it("completes an expired Plan before listing and retains final history", async () => {
    const test = await review();
    const activated = await test.host["plan_creation.activate"](test.request);
    test.setToday(test.draft.end);
    expect((await test.host["plan.list"]({})).active?.planId).toBe(activated.planId);
    test.setToday("1998-10-01");
    await expect(test.host["plan.list"]({})).resolves.toMatchObject({
      active: null,
      closed: [{ planId: activated.planId, closeReason: "completed" }],
    });
    await expect(test.host["plan.history"]({ planId: activated.planId })).resolves.toMatchObject({
      closeActor: "system:plan-completion",
      cleanup: "pending",
      revision: { snapshot: test.draft },
    });
    expect(
      await test.store.all("SELECT * FROM planning_command WHERE command_name = 'plan.close'"),
    ).toEqual([]);
  });

  it("activates dated Workouts, removes the Chat card, and exposes the Plan to readers", async () => {
    const test = await review();
    const result = await test.host["plan_creation.activate"](test.request);
    expect(result).toEqual({
      creationId: test.request.creationId,
      planId: expect.any(String),
      closedPlanId: null,
      activatedAt: today,
    });
    await expect(test.host.readCard()).resolves.toBeNull();
    await expect(test.repository.readUnfinished()).resolves.toBeUndefined();
    const plans = createPlanRepository(test.store);
    await expect(plans.readLatest()).resolves.toMatchObject({
      id: result.planId,
      name: "Improve fitness",
      primaryGoal: "Climb stronger",
      status: "active",
      startDateKey: Number(test.draft.start.replaceAll("-", "")),
      targetDateKey: Number(test.draft.end.replaceAll("-", "")),
    });
    const draftWorkouts = test.draft.weeks.flatMap((week) => week.workouts);
    const workouts = await plans.readWorkouts(result.planId);
    expect(workouts).toHaveLength(draftWorkouts.length);
    expect(workouts.map((workout) => JSON.parse(workout.structureJson))).toEqual(draftWorkouts);
    const model = await createPlanningReadService({
      store: test.store,
      timezone: "UTC",
      now: () => Date.parse(`${test.draft.start}T12:00:00Z`),
    }).getPlanningReadModel({});
    expect(model).toMatchObject({
      status: "ready",
      plan: { id: result.planId, currentWeek: 1, totalWeeks: 4, phase: null },
    });
    if (model.status !== "ready") throw new Error("Expected active Plan");
    expect(model.plan.workouts.map((workout) => workout.name)).toEqual(
      test.draft.weeks[0]?.workouts.map((workout) => workout.name),
    );
  });

  it("activates a Base Plan within its window and retains the later Event Goal in its snapshot", async () => {
    const test = await previewHarness();
    for (const answer of [
      { kind: "goal", goal: { kind: "event-manual", name: "Spring Tour", date: "1999-05-16" } },
      fixedMode,
      fixedAvailability,
      startTiming,
      noCommitments,
      regularBaseline,
      eventSuccess,
      noRestriction,
    ] satisfies readonly PlanCreationAnswerInput[])
      await test.answer(answer);
    const card = test.card();
    const reviewed = await test.host["plan_creation.preview"]({
      commandId: "preview",
      creationId: card.creationId,
      expectedVersion: card.version,
    });
    if (reviewed.status !== "previewed" || reviewed.planCreation.draft === null)
      throw new Error("Expected Base Plan Draft");
    const draft = reviewed.planCreation.draft;
    expect(draft).toMatchObject({
      spanKind: "Base Plan",
      goal: { name: "Spring Tour", date: "1999-05-16" },
    });
    expect(draft.weeks).toHaveLength(12);
    const activated = await test.host["plan_creation.activate"]({
      commandId: "activate",
      creationId: card.creationId,
      expectedVersion: reviewed.planCreation.version,
    });
    await expect(createPlanRepository(test.store).readLatest()).resolves.toMatchObject({
      id: activated.planId,
      name: "Spring Tour",
      targetDateKey: Number(draft.end.replaceAll("-", "")),
      kind: "full_plan",
      totalWeeks: 12,
    });
    expect(Number(draft.end.replaceAll("-", ""))).toBeLessThan(19990516);
    expect(
      await test.store.all("SELECT snapshot_json FROM plan_revision WHERE plan_id = ?", [
        activated.planId,
      ]),
    ).toEqual([{ snapshot_json: canonicalJson(draft) }]);
  });

  it("keeps undated flexible Workouts in the revision snapshot", async () => {
    const test = await review("flexible");
    const result = await test.host["plan_creation.activate"](test.request);
    expect(test.draft.weeks.flatMap((week) => week.workouts).length).toBeGreaterThan(0);
    expect(await test.store.all("SELECT * FROM plan_workout")).toEqual([]);
    expect(
      await test.store.all("SELECT snapshot_json FROM plan_revision WHERE plan_id = ?", [
        result.planId,
      ]),
    ).toEqual([{ snapshot_json: canonicalJson(test.draft) }]);
    await expect(test.host.readCard()).resolves.toBeNull();
  });

  it("replays the original Plan and host date and rejects changed command input", async () => {
    const test = await review();
    const first = await test.host["plan_creation.activate"](test.request);
    const plans = await test.store.all("SELECT * FROM plan");
    const workouts = await test.store.all("SELECT * FROM plan_workout");
    test.advanceDay();
    await expect(test.host["plan_creation.activate"](test.request)).resolves.toEqual(first);
    await expect(
      test.host["plan_creation.activate"]({
        ...test.request,
        expectedVersion: test.request.expectedVersion + 1,
      }),
    ).rejects.toMatchObject({ code: "command-conflict" });
    expect(await test.store.all("SELECT * FROM plan")).toEqual(plans);
    expect(await test.store.all("SELECT * FROM plan_workout")).toEqual(workouts);
    await expect(test.host.readCard()).resolves.toBeNull();
  });

  it("rejects missing Drafts and stale versions without creating a Plan", async () => {
    const test = await previewHarness();
    const card = await test.ready();
    const request = {
      commandId: "activate",
      creationId: card.creationId,
      expectedVersion: card.version,
    };
    await expect(test.host["plan_creation.activate"](request)).rejects.toMatchObject({
      code: "not-ready",
      message: "Build a current complete Draft and resolve pending answers before activation.",
    });
    await expect(
      test.host["plan_creation.activate"]({ ...request, expectedVersion: card.version - 1 }),
    ).rejects.toMatchObject({
      code: "version-conflict",
    });
    expect(await test.store.all("SELECT * FROM plan")).toEqual([]);
    await expect(test.host.readCard()).resolves.toEqual(card);
  });

  it("rejects an edited Draft and preserves its current card", async () => {
    const test = await review();
    const edited = await answered(
      test.host["plan_creation.answer"]({
        ...test.request,
        commandId: "edit",
        answer: { kind: "plan-length", weeks: 8 },
      }),
    );
    await expect(
      test.host["plan_creation.activate"]({ ...test.request, expectedVersion: edited.version }),
    ).rejects.toMatchObject({
      code: "not-ready",
      message: "Build a current complete Draft and resolve pending answers before activation.",
    });
    expect(await test.store.all("SELECT * FROM plan")).toEqual([]);
    await expect(test.host.readCard()).resolves.toEqual(edited);
  });
});
