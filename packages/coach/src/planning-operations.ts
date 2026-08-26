import {
  ExecutePlanTransitionRpcParamsSchema,
  ExecutePlanTransitionRpcResultSchema,
  GetPlanStateRpcParamsSchema,
  GetPlanStateRpcResultSchema,
  PlanDraftPlanProjectionSchema,
  PlanDraftProjectionSchema,
  PlanFtpProjectionSchema,
  PlanRaceCourseProjectionSchema,
  PlanStartDateProjectionSchema,
  PlanProgressEventSchema,
  type ChatQueueRunResult,
  type ChatQueueSnapshot,
  type CoachEngine,
  type ExecutePlanTransitionRpcParams,
  type ExecutePlanTransitionRpcResult,
  type PlanDraftProjection,
  type PlanDraftPlanProjection,
  type PlanError,
  type PlanFtpProjection,
  type PlanProgressEvent,
  type PlanRaceCourseProjection,
  type PlanRaceCourseSummary,
  type PlanStartDateProjection,
  type PlanReadModel,
  type PlanningOperations,
  type TurnEvent,
} from "@enduragent/coach-contract";
import {
  acceptParsedRaceCourse,
  beginRaceCourseParsing,
  beginRaceCourseRemoval,
  completeRaceCourseRecalculation,
  executePlanFtpTransition,
  failRaceCourseRecalculation,
  openRaceCoursePicker,
  previewPlanStartDate,
  rejectRaceCourseFile,
  useRouteWithoutElevation,
  type PlanFtpAdapter,
  type PlanFtpSnapshot,
  type PlanStartDatePreview,
  type RaceCourseRecalculatingState,
} from "@enduragent/engine";
import { buildPlanLifecycleReadModel } from "./planning-lifecycle.js";
import {
  createPlanConversationRepository,
  createPlanRepository,
  type PlanConversationRecord,
  type PlanConversationRepository,
  type PlanConversationTurnRecord,
  type PlanDraftRevisionRecord,
  type PlanRecord,
  type PlanRepository,
  type PlanWorkoutRecord,
  parseRaceCourseSnapshot,
  type RaceCourseSnapshot,
} from "@enduragent/kernel/planning";
import type { AuthoredIdentity } from "@enduragent/kernel-node/home";
import type { CoachStoreWriterContext } from "./runtime.js";
import type { PlanRaceCourseAdapter } from "./planning-race-course.js";

const EMPTY_QUEUE: ChatQueueSnapshot = Object.freeze({
  schemaVersion: 1,
  revision: 0,
  items: [],
});

const UNAVAILABLE: PlanError = Object.freeze({
  code: "unavailable",
  message: "This Plan action is not available yet.",
  retryable: true,
});

const PROVIDER_FAILED: PlanError = Object.freeze({
  code: "provider-failed",
  message: "The coach couldn’t respond. Try again.",
  retryable: true,
});

const PERSISTENCE_FAILED: PlanError = Object.freeze({
  code: "persistence-failed",
  message: "The Plan couldn’t save that change. Try again.",
  retryable: true,
});

const FTP_REFRESH_FAILED: PlanError = Object.freeze({
  code: "provider-failed",
  message: "Couldn’t refresh Intervals. Try again.",
  retryable: true,
});

const FTP_SAVE_FAILED: PlanError = Object.freeze({
  code: "persistence-failed",
  message: "FTP couldn’t be saved. Try again.",
  retryable: true,
});

const COURSE_INVALID: PlanError = Object.freeze({
  code: "invalid-input",
  message: "This file can’t be read. Choose another GPX or FIT file.",
  retryable: true,
});

const COURSE_RECALCULATION_FAILED: PlanError = Object.freeze({
  code: "provider-failed",
  message: "The Draft could not be recalculated. Your previous Draft is unchanged.",
  retryable: true,
});

const START_DATE_INVALID: PlanError = Object.freeze({
  code: "invalid-input",
  message: "Choose a start date from today through the Goal Event.",
  retryable: true,
});

const START_DATE_RECALCULATION_FAILED: PlanError = Object.freeze({
  code: "provider-failed",
  message: "The Plan could not be recalculated. Your current Draft is safe.",
  retryable: true,
});

export interface PlanDraftBuild {
  readonly plan: PlanRecord;
  readonly workouts: readonly PlanWorkoutRecord[];
  readonly snapshot: unknown;
}

export interface PlanDraftBuilder {
  form(input: {
    readonly conversation: PlanConversationRecord;
    readonly turns: readonly PlanConversationTurnRecord[];
    readonly course: RaceCourseSnapshot | null;
  }): Promise<PlanDraftBuild>;
  revise(input: {
    readonly conversation: PlanConversationRecord;
    readonly turns: readonly PlanConversationTurnRecord[];
    readonly previous: PlanDraftRevisionRecord;
    readonly instruction: string;
    readonly course: RaceCourseSnapshot | null;
  }): Promise<PlanDraftBuild>;
  recalculateCourse(input: {
    readonly conversation: PlanConversationRecord;
    readonly turns: readonly PlanConversationTurnRecord[];
    readonly previous: PlanDraftRevisionRecord;
    readonly course: RaceCourseSnapshot | null;
  }): Promise<PlanDraftBuild>;
  recalculateStartDate?(input: {
    readonly conversation: PlanConversationRecord;
    readonly turns: readonly PlanConversationTurnRecord[];
    readonly previous: PlanDraftRevisionRecord;
    readonly preview: PlanStartDatePreview;
    readonly course: RaceCourseSnapshot | null;
  }): Promise<PlanDraftBuild>;
}

export interface PlanReadinessInput {
  readonly conversation: PlanConversationRecord;
  readonly turns: readonly PlanConversationTurnRecord[];
  readonly draft: PlanDraftRevisionRecord | undefined;
}

export interface CreatePlanningOperationsDependencies {
  readonly conversations?: PlanConversationRepository;
  readonly plans?: PlanRepository;
  readonly draftBuilder?: PlanDraftBuilder;
  readonly isReady?: (input: PlanReadinessInput) => boolean | Promise<boolean>;
  readonly ftp?: PlanFtpAdapter;
  readonly course?: PlanRaceCourseAdapter;
  readonly todayDateKey?: () => number;
}

function createSerializedLane(): <T>(operation: () => Promise<T>) => Promise<T> {
  let tail = Promise.resolve();
  return <T>(operation: () => Promise<T>): Promise<T> => {
    const task = tail.then(operation, operation);
    tail = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  };
}

function snapshot(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function dateText(dateKey: number): string {
  const value = String(dateKey).padStart(8, "0");
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

function utcTodayDateKey(): number {
  const now = new Date();
  return now.getUTCFullYear() * 10_000 + (now.getUTCMonth() + 1) * 100 + now.getUTCDate();
}

function draftPlanProjection(
  plan: PlanRecord | undefined,
  workouts: readonly PlanWorkoutRecord[],
): PlanDraftPlanProjection | null {
  if (plan === undefined) return null;
  return PlanDraftPlanProjectionSchema.parse({
    id: plan.id,
    name: plan.name,
    primaryGoal: plan.primaryGoal,
    startDate: dateText(plan.startDateKey),
    targetDate: plan.targetDateKey === null ? null : dateText(plan.targetDateKey),
    kind: plan.kind === "full_plan" ? "full-plan" : "short-race-preparation",
    totalWeeks: plan.totalWeeks,
    weekStartDay: plan.weekStartDay,
    workoutCount: workouts.length,
    plannedDurationS: workouts.reduce((total, workout) => total + (workout.durationS ?? 0), 0),
  });
}

function startDateProjection(input: {
  readonly plan: PlanRecord;
  readonly todayDateKey: number;
  readonly status?: PlanStartDateProjection["status"];
  readonly selectedDate?: string;
  readonly error?: PlanError | null;
}): PlanStartDateProjection | undefined {
  if (input.plan.targetDateKey === null) return undefined;
  const selectedDate = input.selectedDate ?? dateText(input.plan.startDateKey);
  try {
    const preview = previewPlanStartDate({
      planStatus: input.plan.status,
      startDate: selectedDate,
      today: dateText(input.todayDateKey),
      targetDate: dateText(input.plan.targetDateKey),
    });
    return PlanStartDateProjectionSchema.parse({
      status: input.status ?? "ready",
      selectedDate,
      today: dateText(input.todayDateKey),
      targetDate: dateText(input.plan.targetDateKey),
      kind: preview.kind === "full_plan" ? "full-plan" : "short-race-preparation",
      inclusiveDays: preview.inclusiveDays,
      totalWeeks: preview.totalWeeks,
      raceWeekday: preview.raceWeekday,
      raceDayOfPlanWeek: preview.raceDayOfPlanWeek,
      error: input.error ?? null,
    });
  } catch {
    return PlanStartDateProjectionSchema.parse({
      status: "invalid",
      selectedDate,
      today: dateText(input.todayDateKey),
      targetDate: dateText(input.plan.targetDateKey),
      kind: null,
      inclusiveDays: null,
      totalWeeks: null,
      raceWeekday: null,
      raceDayOfPlanWeek: null,
      error: input.error ?? START_DATE_INVALID,
    });
  }
}

function draftProjection(value: PlanDraftRevisionRecord | undefined): PlanDraftProjection | null {
  if (value === undefined) return null;
  return PlanDraftProjectionSchema.parse({
    id: value.id,
    planId: value.planId,
    revision: value.revision,
    status: value.status,
    snapshot: snapshot(value.snapshotJson),
  });
}

type FtpScenario = "PL-S057" | "PL-S058" | "PL-S059" | "PL-S060" | "PL-S061" | "PL-S062";

function ftpProjection(
  value: PlanFtpSnapshot,
  scenario: FtpScenario | undefined,
  error: PlanError | null,
): PlanFtpProjection {
  const status =
    scenario === "PL-S058"
      ? "no-source"
      : scenario === "PL-S059"
        ? "refresh-failed"
        : scenario === "PL-S060"
          ? "conflict"
          : value.usedSource === null
            ? "required"
            : value.conflict
              ? "conflict"
              : "accepted";
  return PlanFtpProjectionSchema.parse({
    status,
    manual: value.manual,
    intervalsFtp: value.intervalsFtp,
    intervalsEftp: value.intervalsEftp,
    usedSource: value.usedSource,
    usedWatts: value.usedWatts,
    conflict: value.conflict,
    error: status === "refresh-failed" ? error : null,
  });
}

type CourseScenario =
  | "PL-S064"
  | "PL-S065"
  | "PL-S067"
  | "PL-S068"
  | "PL-S069"
  | "PL-S070"
  | "PL-S104";

function courseSummary(value: RaceCourseSnapshot): PlanRaceCourseSummary {
  return {
    fileName: value.fileName,
    format: value.format,
    pointCount: value.preview.pointCount,
    distanceM: value.preview.distanceM,
    elevationGainM: value.preview.elevationGainM,
    elevationStatus: value.preview.elevationStatus,
  };
}

function courseFromJson(value: string | null): RaceCourseSnapshot | null {
  return value === null ? null : parseRaceCourseSnapshot(JSON.parse(value) as unknown);
}

function storedCourseProjection(
  conversation: PlanConversationRecord,
  draft: PlanDraftRevisionRecord | undefined,
): PlanRaceCourseProjection {
  if (draft !== undefined && draft.status !== "discarded") {
    const course = courseFromJson(draft.raceCourseJson);
    return PlanRaceCourseProjectionSchema.parse(
      course === null
        ? { status: "omitted", accepted: null, candidate: null, fileName: null, detail: null }
        : {
            status: "ready",
            accepted: courseSummary(course),
            candidate: null,
            fileName: null,
            detail: null,
          },
    );
  }
  const course = courseFromJson(conversation.raceCourseJson);
  if (conversation.courseChoiceStatus === "undecided") {
    return PlanRaceCourseProjectionSchema.parse({
      status: "undecided",
      accepted: null,
      candidate: null,
      fileName: null,
      detail: null,
    });
  }
  return PlanRaceCourseProjectionSchema.parse(
    course === null
      ? { status: "omitted", accepted: null, candidate: null, fileName: null, detail: null }
      : {
          status: "ready",
          accepted: courseSummary(course),
          candidate: null,
          fileName: null,
          detail: null,
        },
  );
}

function courseProjection(input: {
  readonly status: PlanRaceCourseProjection["status"];
  readonly accepted?: RaceCourseSnapshot | null;
  readonly candidate?: RaceCourseSnapshot | null;
  readonly fileName?: string | null;
  readonly detail?: string | null;
}): PlanRaceCourseProjection {
  return PlanRaceCourseProjectionSchema.parse({
    status: input.status,
    accepted:
      input.accepted === undefined || input.accepted === null
        ? null
        : courseSummary(input.accepted),
    candidate:
      input.candidate === undefined || input.candidate === null
        ? null
        : courseSummary(input.candidate),
    fileName: input.fileName ?? null,
    detail: input.detail ?? null,
  });
}

interface ReadOverrides {
  readonly ftpScenario?: FtpScenario;
  readonly ftpError?: PlanError | null;
  readonly courseScenario?: CourseScenario;
  readonly course?: PlanRaceCourseProjection;
  readonly dateScenario?: "PL-S046" | "PL-S048" | "PL-S050";
  readonly startDate?: PlanStartDateProjection;
}

function queueText(queue: ChatQueueSnapshot): string {
  const head = queue.items[0];
  if (head === undefined) return "";
  if (queue.retryRequired !== undefined) {
    return queue.items
      .slice(0, queue.retryRequired.queuedMessageIds.length)
      .map((item) => item.text)
      .join("\n\n");
  }
  if (head.kind === "slash-command") return head.text;
  let size = 1;
  while (queue.items[size]?.kind === "ordinary") size += 1;
  return queue.items
    .slice(0, size)
    .map((item) => item.text)
    .join("\n\n");
}

export function createPlanningOperations(
  input: {
    readonly context: CoachStoreWriterContext;
    readonly engine: CoachEngine;
    readonly identity: AuthoredIdentity;
  },
  dependencies: CreatePlanningOperationsDependencies = {},
): PlanningOperations {
  const conversations =
    dependencies.conversations ?? createPlanConversationRepository(input.context.store);
  const plans = dependencies.plans ?? createPlanRepository(input.context.store);
  const enqueue = createSerializedLane();

  const read = async (overrides: ReadOverrides = {}): Promise<PlanReadModel> => {
    const conversation = await conversations.readLatestOpenConversation();
    if (conversation === undefined) {
      return buildPlanLifecycleReadModel({
        conversation: null,
        turns: [],
        readyToCreateDraft: false,
        queue: EMPTY_QUEUE,
        decision: null,
        draft: null,
      });
    }
    const chatId = `plan:${conversation.id}`;
    const [turns, draft, queue, decision, ftp] = await Promise.all([
      conversations.readTurns(conversation.id),
      conversations.readLatestDraftRevision(conversation.id),
      input.engine.getChatQueue?.({ chatId }).catch(() => EMPTY_QUEUE) ?? EMPTY_QUEUE,
      input.engine
        .getCoachDecision({ chatId })
        .then((result) => result.decision)
        .catch(() => null),
      dependencies.ftp?.read(),
    ]);
    const draftPlan = draft === undefined ? undefined : await plans.read(draft.planId);
    const draftWorkouts = draftPlan === undefined ? [] : await plans.readWorkouts(draftPlan.id);
    const todayDateKey = dependencies.todayDateKey?.() ?? utcTodayDateKey();
    const projectedStartDate =
      overrides.startDate ??
      (draftPlan === undefined
        ? undefined
        : startDateProjection({ plan: draftPlan, todayDateKey }));
    const dateScenario =
      overrides.dateScenario ?? (projectedStartDate?.status === "invalid" ? "PL-S046" : undefined);
    const ready =
      conversation.courseChoiceStatus !== "undecided" &&
      (await (dependencies.isReady?.({ conversation, turns, draft }) ?? Promise.resolve(false)));
    return buildPlanLifecycleReadModel({
      conversation: {
        id: conversation.id,
        planId: conversation.planId,
        replacesPlanId: conversation.replacesPlanId,
        sourceConversationId: null,
      },
      turns,
      readyToCreateDraft: ready,
      queue,
      decision,
      draft: draftProjection(draft),
      plan: draftPlanProjection(draftPlan, draftWorkouts),
      startDate: projectedStartDate,
      ...(ftp === undefined
        ? {}
        : { ftp: ftpProjection(ftp, overrides.ftpScenario, overrides.ftpError ?? null) }),
      ...(overrides.ftpScenario === undefined ? {} : { ftpScenario: overrides.ftpScenario }),
      course: overrides.course ?? storedCourseProjection(conversation, draft),
      ...(overrides.courseScenario === undefined
        ? {}
        : { courseScenario: overrides.courseScenario }),
      ...(dateScenario === undefined ? {} : { dateScenario }),
    });
  };

  const deliver = (
    onEvent: ((event: PlanProgressEvent) => void) | undefined,
    event: PlanProgressEvent,
  ): void => {
    const parsed = PlanProgressEventSchema.parse(event);
    try {
      onEvent?.(parsed);
    } catch {}
  };

  const appendTurn = async (
    conversationId: string,
    athleteText: string,
    coachText: string,
    engineTurnId: string | null,
  ): Promise<void> => {
    if (!/\S/u.test(coachText) || engineTurnId === null) return;
    const existing = await conversations.readTurns(conversationId);
    if (
      existing.some((turn) => {
        const lineage = snapshot(turn.lineageJson) as { readonly engineTurnId?: unknown };
        return lineage.engineTurnId === engineTurnId;
      })
    ) {
      return;
    }
    const stamp = input.identity.hlcStamp();
    await conversations.appendTurn({
      id: input.identity.newUlid(),
      conversationId,
      sequence: existing.length + 1,
      athleteText,
      coachText,
      lineageJson: JSON.stringify({ engineTurnId }),
      completedAtMs: stamp.physicalMs,
      deviceId: await input.identity.deviceId(),
      hlcPhysicalMs: stamp.physicalMs,
      hlcCounter: stamp.counter,
    });
  };

  const executeCoachCall = async (
    command: Extract<ExecutePlanTransitionRpcParams, { transitionId: "PL-T05" }>,
    operationId: string,
    onEvent: ((event: PlanProgressEvent) => void) | undefined,
  ): Promise<void> => {
    const conversation = await conversations.readConversation(command.conversationId);
    if (conversation === undefined || conversation.status !== "open") throw UNAVAILABLE;
    const chatId = `plan:${conversation.id}`;
    const forward = (event: TurnEvent): void => {
      deliver(onEvent, {
        commandId: command.commandId,
        transitionId: command.transitionId,
        operationId,
        phase: "running",
        completed: 0,
        total: 1,
        turnEvent: event,
      });
    };
    let pendingText = command.text;
    let queue = await (input.engine.getChatQueue?.({ chatId }) ?? Promise.resolve(EMPTY_QUEUE));
    if (command.decision !== undefined) {
      let turnId: string | null = null;
      const onTurnEvent = (event: TurnEvent): void => {
        if (event.type === "turn-start") turnId = event.turnId;
        forward(event);
      };
      if (command.decision.action === "skip") {
        await input.engine.skipCoachDecision({
          chatId,
          decisionId: command.decision.decisionId,
        });
        return;
      }
      const result =
        command.decision.action === "answer"
          ? await input.engine.answerCoachDecision(
              {
                chatId,
                decisionId: command.decision.decisionId,
                answer: command.decision.answer,
              },
              onTurnEvent,
            )
          : await input.engine.resumeCoachDecision(
              { chatId, decisionId: command.decision.decisionId },
              onTurnEvent,
            );
      const continuation =
        result.decision.status === "answered" ? result.decision.continuation : null;
      if (continuation?.status === "completed") {
        await appendTurn(
          conversation.id,
          pendingText,
          continuation.coachText,
          turnId ?? continuation.turnId,
        );
      }
      return;
    }
    let first = true;
    while (first || queue.items.length > 0) {
      first = false;
      let turnId: string | null = null;
      const onTurnEvent = (event: TurnEvent): void => {
        if (event.type === "turn-start") turnId = event.turnId;
        forward(event);
      };
      let resultText = "";
      if (queue.items.length > 0 && queueText(queue) === pendingText) {
        let result: ChatQueueRunResult;
        if (queue.retryRequired !== undefined) {
          if (input.engine.retryQueuedTurn === undefined) throw UNAVAILABLE;
          result = await input.engine.retryQueuedTurn(
            { chatId, claimId: queue.retryRequired.claimId },
            onTurnEvent,
          );
        } else if (queue.items[0]?.kind === "slash-command" && queue.items[0]?.restored) {
          if (input.engine.runQueuedCommand === undefined) throw UNAVAILABLE;
          result = await input.engine.runQueuedCommand(
            { chatId, queuedMessageId: queue.items[0].queuedMessageId },
            onTurnEvent,
          );
        } else {
          if (input.engine.resumeChatQueue === undefined) throw UNAVAILABLE;
          result = await input.engine.resumeChatQueue({ chatId }, onTurnEvent);
        }
        resultText = result.response?.text ?? "";
        queue = result.snapshot;
      } else {
        const result = await input.engine.chat({ chatId, message: pendingText }, onTurnEvent);
        resultText = result.text;
        queue = await (input.engine.getChatQueue?.({ chatId }) ?? Promise.resolve(EMPTY_QUEUE));
      }
      await appendTurn(conversation.id, pendingText, resultText, turnId);
      if (queue.retryRequired !== undefined || queue.items.length === 0) break;
      const nextText = queueText(queue);
      if (!/\S/u.test(nextText) || (nextText === pendingText && resultText.length === 0)) break;
      pendingText = nextText;
    }
  };

  const saveDraft = async (
    conversation: PlanConversationRecord,
    previous: PlanDraftRevisionRecord | undefined,
    build: PlanDraftBuild,
    course: RaceCourseSnapshot | null,
  ): Promise<void> => {
    const timestamp = input.identity.hlcStamp().physicalMs;
    await plans.replace(build.plan, build.workouts);
    const conversationStamp = input.identity.hlcStamp();
    await conversations.saveConversation({
      ...conversation,
      planId: build.plan.id,
      courseChoiceStatus: course === null ? "omitted" : "attached",
      raceCourseJson: course === null ? null : JSON.stringify(course),
      updatedAtMs: timestamp,
      deviceId: await input.identity.deviceId(),
      hlcPhysicalMs: conversationStamp.physicalMs,
      hlcCounter: conversationStamp.counter,
    });
    const stamp = input.identity.hlcStamp();
    await conversations.saveDraftRevision({
      id: input.identity.newUlid(),
      conversationId: conversation.id,
      planId: build.plan.id,
      revision: (previous?.revision ?? 0) + 1,
      parentRevisionId: previous?.id ?? null,
      status: "ready",
      snapshotJson: JSON.stringify(build.snapshot),
      raceCourseJson: course === null ? null : JSON.stringify(course),
      createdAtMs: timestamp,
      updatedAtMs: timestamp,
      deviceId: await input.identity.deviceId(),
      hlcPhysicalMs: stamp.physicalMs,
      hlcCounter: stamp.counter,
    });
  };

  const saveConversationCourse = async (
    conversation: PlanConversationRecord,
    course: RaceCourseSnapshot | null,
  ): Promise<void> => {
    const stamp = input.identity.hlcStamp();
    await conversations.saveConversation({
      ...conversation,
      courseChoiceStatus: course === null ? "omitted" : "attached",
      raceCourseJson: course === null ? null : JSON.stringify(course),
      updatedAtMs: stamp.physicalMs,
      deviceId: await input.identity.deviceId(),
      hlcPhysicalMs: stamp.physicalMs,
      hlcCounter: stamp.counter,
    });
  };

  const reject = async (
    error: PlanError,
    overrides: ReadOverrides = {},
  ): Promise<ExecutePlanTransitionRpcResult> =>
    ExecutePlanTransitionRpcResultSchema.parse({
      status: "rejected",
      error,
      state: await read({ ...overrides, ftpError: error }),
    });

  return {
    async getPlanState(request) {
      GetPlanStateRpcParamsSchema.parse(request);
      return GetPlanStateRpcResultSchema.parse({ status: "ready", state: await read() });
    },
    executePlanTransition(request, onEvent) {
      const command = ExecutePlanTransitionRpcParamsSchema.parse(request);
      return enqueue(async () => {
        if (command.transitionId === "PL-T01") {
          let conversation = await conversations.readLatestOpenConversation();
          if (conversation === undefined) {
            const timestamp = input.identity.hlcStamp().physicalMs;
            const stamp = input.identity.hlcStamp();
            conversation = {
              id: input.identity.newUlid(),
              planId: null,
              replacesPlanId: null,
              courseChoiceStatus: "undecided",
              raceCourseJson: null,
              status: "open",
              endedAtMs: null,
              createdAtMs: timestamp,
              updatedAtMs: timestamp,
              deviceId: await input.identity.deviceId(),
              hlcPhysicalMs: stamp.physicalMs,
              hlcCounter: stamp.counter,
            };
            await conversations.saveConversation(conversation);
          }
          return ExecutePlanTransitionRpcResultSchema.parse({
            status: "completed",
            state: await read(),
          });
        }
        if (command.transitionId === "PL-T02") {
          if (dependencies.course === undefined) return reject(UNAVAILABLE);
          const conversation = await conversations.readConversation(command.conversationId);
          if (conversation === undefined || conversation.status !== "open") {
            return reject(UNAVAILABLE);
          }
          const draft = await conversations.readLatestDraftRevision(conversation.id);
          if (draft !== undefined && draft.status !== "discarded") return reject(UNAVAILABLE);
          const accepted = courseFromJson(conversation.raceCourseJson);
          const operationId = input.identity.newUlid();
          deliver(onEvent, {
            commandId: command.commandId,
            transitionId: command.transitionId,
            operationId,
            phase: "running",
            completed: 0,
            total: 1,
          });
          const parsed = await dependencies.course.parse(command.filePath);
          const picker = openRaceCoursePicker({
            planStatus: "draft",
            draft: null,
            acceptedCourse: accepted,
          });
          const parsing = beginRaceCourseParsing(
            picker,
            parsed.ok ? parsed.course.fileName : parsed.fileName,
          );
          if (!parsed.ok) {
            const invalid = rejectRaceCourseFile(parsing, parsed.detail);
            deliver(onEvent, {
              commandId: command.commandId,
              transitionId: command.transitionId,
              operationId,
              phase: "failed",
              completed: 0,
              total: 1,
            });
            return reject(COURSE_INVALID, {
              courseScenario: "PL-S065",
              course: courseProjection({
                status: "invalid",
                accepted: invalid.acceptedCourse,
                fileName: invalid.fileName,
                detail: invalid.detail,
              }),
            });
          }
          let next = acceptParsedRaceCourse(parsing, parsed.course);
          if (next.kind === "course-missing-elevation" && command.elevation === "require") {
            deliver(onEvent, {
              commandId: command.commandId,
              transitionId: command.transitionId,
              operationId,
              phase: "completed",
              completed: 1,
              total: 1,
            });
            return ExecutePlanTransitionRpcResultSchema.parse({
              status: "completed",
              state: await read({
                courseScenario: "PL-S067",
                course: courseProjection({
                  status: "missing-elevation",
                  accepted: next.acceptedCourse,
                  candidate: next.candidateCourse,
                }),
              }),
            });
          }
          if (next.kind === "course-missing-elevation") next = useRouteWithoutElevation(next);
          const ready = completeRaceCourseRecalculation(next, {
            planStatus: "draft",
            recalculatedDraft: null,
          });
          try {
            await saveConversationCourse(conversation, ready.acceptedCourse);
            deliver(onEvent, {
              commandId: command.commandId,
              transitionId: command.transitionId,
              operationId,
              phase: "completed",
              completed: 1,
              total: 1,
            });
            return ExecutePlanTransitionRpcResultSchema.parse({
              status: "completed",
              state: await read(),
            });
          } catch {
            deliver(onEvent, {
              commandId: command.commandId,
              transitionId: command.transitionId,
              operationId,
              phase: "failed",
              completed: 0,
              total: 1,
            });
            return reject(PERSISTENCE_FAILED);
          }
        }
        if (command.transitionId === "PL-T03") {
          const conversation = await conversations.readConversation(command.conversationId);
          if (conversation === undefined || conversation.status !== "open") {
            return reject(UNAVAILABLE);
          }
          const draft = await conversations.readLatestDraftRevision(conversation.id);
          if (draft !== undefined && draft.status !== "discarded") return reject(UNAVAILABLE);
          try {
            await saveConversationCourse(conversation, null);
            return ExecutePlanTransitionRpcResultSchema.parse({
              status: "completed",
              state: await read(),
            });
          } catch {
            return reject(PERSISTENCE_FAILED, {
              courseScenario: "PL-S104",
              course: courseProjection({
                status: "omission-failed",
                detail: "Couldn’t continue without a Race Course. Nothing changed.",
              }),
            });
          }
        }
        if (command.transitionId === "PL-T05") {
          const operationId = input.identity.newUlid();
          deliver(onEvent, {
            commandId: command.commandId,
            transitionId: command.transitionId,
            operationId,
            phase: "queued",
            completed: 0,
            total: 1,
          });
          try {
            await executeCoachCall(command, operationId, onEvent);
            deliver(onEvent, {
              commandId: command.commandId,
              transitionId: command.transitionId,
              operationId,
              phase: "completed",
              completed: 1,
              total: 1,
            });
            return ExecutePlanTransitionRpcResultSchema.parse({
              status: "completed",
              state: await read(),
            });
          } catch (error) {
            deliver(onEvent, {
              commandId: command.commandId,
              transitionId: command.transitionId,
              operationId,
              phase: "failed",
              completed: 0,
              total: 1,
            });
            return reject(error === UNAVAILABLE ? UNAVAILABLE : PROVIDER_FAILED);
          }
        }
        if (command.transitionId === "PL-T04") {
          if (dependencies.ftp === undefined) return reject(UNAVAILABLE);
          const conversation = await conversations.readConversation(command.conversationId);
          if (conversation === undefined || conversation.status !== "open")
            return reject(UNAVAILABLE);
          const operationId = input.identity.newUlid();
          deliver(onEvent, {
            commandId: command.commandId,
            transitionId: command.transitionId,
            operationId,
            phase: "running",
            completed: 0,
            total: 1,
          });
          try {
            const ftp = await executePlanFtpTransition(dependencies.ftp, {
              source: command.source,
              watts: command.watts,
            });
            const scenario: FtpScenario =
              ftp.usedSource === null ? "PL-S058" : ftp.conflict ? "PL-S060" : "PL-S062";
            deliver(onEvent, {
              commandId: command.commandId,
              transitionId: command.transitionId,
              operationId,
              phase: "completed",
              completed: 1,
              total: 1,
            });
            return ExecutePlanTransitionRpcResultSchema.parse({
              status: "completed",
              state: await read({ ftpScenario: scenario }),
            });
          } catch {
            deliver(onEvent, {
              commandId: command.commandId,
              transitionId: command.transitionId,
              operationId,
              phase: "failed",
              completed: 0,
              total: 1,
            });
            return command.source === "manual"
              ? reject(FTP_SAVE_FAILED, { ftpScenario: "PL-S061" })
              : reject(FTP_REFRESH_FAILED, { ftpScenario: "PL-S059" });
          }
        }
        if (command.transitionId === "PL-T06" || command.transitionId === "PL-T07") {
          if (dependencies.draftBuilder === undefined) return reject(UNAVAILABLE);
          const operationId = input.identity.newUlid();
          deliver(onEvent, {
            commandId: command.commandId,
            transitionId: command.transitionId,
            operationId,
            phase: "running",
            completed: 0,
            total: 1,
          });
          try {
            const selectedDraft =
              command.transitionId === "PL-T07"
                ? await conversations.readDraftRevision(command.draftId)
                : undefined;
            const conversation =
              command.transitionId === "PL-T06"
                ? await conversations.readConversation(command.conversationId)
                : selectedDraft === undefined
                  ? undefined
                  : await conversations.readConversationByPlanId(selectedDraft.planId);
            if (conversation === undefined || conversation.status !== "open")
              return reject(UNAVAILABLE);
            const turns = await conversations.readTurns(conversation.id);
            const previous = await conversations.readLatestDraftRevision(conversation.id);
            if (
              command.transitionId === "PL-T06" &&
              (conversation.courseChoiceStatus === "undecided" ||
                !(await (dependencies.isReady?.({ conversation, turns, draft: previous }) ??
                  Promise.resolve(false))))
            ) {
              return reject(UNAVAILABLE);
            }
            const course =
              previous === undefined
                ? courseFromJson(conversation.raceCourseJson)
                : courseFromJson(previous.raceCourseJson);
            const build =
              command.transitionId === "PL-T06"
                ? await dependencies.draftBuilder.form({ conversation, turns, course })
                : previous === undefined
                  ? null
                  : await dependencies.draftBuilder.revise({
                      conversation,
                      turns,
                      previous,
                      instruction: command.text,
                      course,
                    });
            if (build === null) return reject(UNAVAILABLE);
            await saveDraft(conversation, previous, build, course);
            deliver(onEvent, {
              commandId: command.commandId,
              transitionId: command.transitionId,
              operationId,
              phase: "completed",
              completed: 1,
              total: 1,
            });
            return ExecutePlanTransitionRpcResultSchema.parse({
              status: "completed",
              state: await read(),
            });
          } catch {
            deliver(onEvent, {
              commandId: command.commandId,
              transitionId: command.transitionId,
              operationId,
              phase: "failed",
              completed: 0,
              total: 1,
            });
            return reject(PERSISTENCE_FAILED);
          }
        }
        if (command.transitionId === "PL-T08") {
          if (dependencies.draftBuilder?.recalculateStartDate === undefined) {
            return reject(UNAVAILABLE);
          }
          const current = await conversations.readDraftRevision(command.draftId);
          if (current === undefined || current.status !== "ready") return reject(UNAVAILABLE);
          const [latest, conversation, currentPlan] = await Promise.all([
            conversations.readLatestDraftRevision(current.conversationId),
            conversations.readConversation(current.conversationId),
            plans.read(current.planId),
          ]);
          if (
            latest?.id !== current.id ||
            conversation === undefined ||
            conversation.status !== "open" ||
            currentPlan === undefined ||
            currentPlan.status !== "draft" ||
            currentPlan.targetDateKey === null
          ) {
            return reject(UNAVAILABLE);
          }
          const todayDateKey = dependencies.todayDateKey?.() ?? utcTodayDateKey();
          let preview: PlanStartDatePreview;
          try {
            preview = previewPlanStartDate({
              planStatus: currentPlan.status,
              startDate: command.startDate,
              today: dateText(todayDateKey),
              targetDate: dateText(currentPlan.targetDateKey),
            });
          } catch {
            return reject(START_DATE_INVALID, {
              dateScenario: "PL-S046",
              startDate: startDateProjection({
                plan: currentPlan,
                todayDateKey,
                selectedDate: command.startDate,
                error: START_DATE_INVALID,
              }),
            });
          }
          const operationId = input.identity.newUlid();
          deliver(onEvent, {
            commandId: command.commandId,
            transitionId: command.transitionId,
            operationId,
            phase: "running",
            completed: 0,
            total: 1,
          });
          const currentWorkouts = await plans.readWorkouts(currentPlan.id);
          const turns = await conversations.readTurns(conversation.id);
          const course = courseFromJson(current.raceCourseJson);
          try {
            const build = await dependencies.draftBuilder.recalculateStartDate({
              conversation,
              turns,
              previous: current,
              preview,
              course,
            });
            if (
              build.plan.id !== currentPlan.id ||
              build.plan.status !== "draft" ||
              build.plan.targetDateKey !== preview.targetDateKey ||
              build.plan.startDateKey !== preview.startDateKey ||
              build.plan.kind !== preview.kind ||
              build.plan.totalWeeks !== preview.totalWeeks ||
              build.plan.weekStartDay !== preview.weekStartDay
            ) {
              throw new TypeError("Start-date recalculation returned an inconsistent Draft.");
            }
            await saveDraft(conversation, current, build, course);
            deliver(onEvent, {
              commandId: command.commandId,
              transitionId: command.transitionId,
              operationId,
              phase: "completed",
              completed: 1,
              total: 1,
            });
            return ExecutePlanTransitionRpcResultSchema.parse({
              status: "completed",
              state: await read({
                dateScenario: "PL-S050",
                startDate: startDateProjection({
                  plan: build.plan,
                  todayDateKey,
                  status: "updated",
                }),
              }),
            });
          } catch {
            await plans.replace(currentPlan, currentWorkouts).catch(() => undefined);
            deliver(onEvent, {
              commandId: command.commandId,
              transitionId: command.transitionId,
              operationId,
              phase: "failed",
              completed: 0,
              total: 1,
            });
            return reject(START_DATE_RECALCULATION_FAILED, {
              dateScenario: "PL-S048",
              startDate: startDateProjection({
                plan: currentPlan,
                todayDateKey,
                selectedDate: command.startDate,
                status: "failed",
                error: START_DATE_RECALCULATION_FAILED,
              }),
            });
          }
        }
        if (command.transitionId === "PL-T09") {
          if (dependencies.draftBuilder === undefined) return reject(UNAVAILABLE);
          const current = await conversations.readDraftRevision(command.draftId);
          if (current === undefined || current.status !== "ready") return reject(UNAVAILABLE);
          const conversation = await conversations.readConversation(current.conversationId);
          const plan = await plans.read(current.planId);
          if (
            conversation === undefined ||
            conversation.status !== "open" ||
            plan === undefined ||
            plan.status !== "draft"
          ) {
            return reject(UNAVAILABLE);
          }
          const accepted = courseFromJson(current.raceCourseJson);
          const picker = openRaceCoursePicker({
            planStatus: plan.status,
            draft: current,
            acceptedCourse: accepted,
          });
          let recalculating: RaceCourseRecalculatingState<PlanDraftRevisionRecord>;
          if (command.course.action === "remove") {
            recalculating = beginRaceCourseRemoval(picker);
          } else {
            if (dependencies.course === undefined) return reject(UNAVAILABLE);
            const parsed = await dependencies.course.parse(command.course.filePath);
            const parsing = beginRaceCourseParsing(
              picker,
              parsed.ok ? parsed.course.fileName : parsed.fileName,
            );
            if (!parsed.ok) {
              const invalid = rejectRaceCourseFile(parsing, parsed.detail);
              return reject(COURSE_INVALID, {
                courseScenario: "PL-S065",
                course: courseProjection({
                  status: "invalid",
                  accepted: invalid.acceptedCourse,
                  fileName: invalid.fileName,
                  detail: invalid.detail,
                }),
              });
            }
            let next = acceptParsedRaceCourse(parsing, parsed.course);
            if (
              next.kind === "course-missing-elevation" &&
              command.course.elevation === "require"
            ) {
              return ExecutePlanTransitionRpcResultSchema.parse({
                status: "completed",
                state: await read({
                  courseScenario: "PL-S067",
                  course: courseProjection({
                    status: "missing-elevation",
                    accepted: next.acceptedCourse,
                    candidate: next.candidateCourse,
                  }),
                }),
              });
            }
            if (next.kind === "course-missing-elevation") next = useRouteWithoutElevation(next);
            recalculating = next;
          }
          const operationId = input.identity.newUlid();
          deliver(onEvent, {
            commandId: command.commandId,
            transitionId: command.transitionId,
            operationId,
            phase: "running",
            completed: 0,
            total: 1,
          });
          const turns = await conversations.readTurns(conversation.id);
          try {
            const build = await dependencies.draftBuilder.recalculateCourse({
              conversation,
              turns,
              previous: current,
              course: recalculating.candidateCourse,
            });
            const ready = completeRaceCourseRecalculation(recalculating, {
              planStatus: plan.status,
              recalculatedDraft: build,
            });
            await saveDraft(conversation, current, ready.draft, ready.acceptedCourse);
            deliver(onEvent, {
              commandId: command.commandId,
              transitionId: command.transitionId,
              operationId,
              phase: "completed",
              completed: 1,
              total: 1,
            });
            return ExecutePlanTransitionRpcResultSchema.parse({
              status: "completed",
              state: await read(ready.acceptedCourse === null ? {} : { courseScenario: "PL-S070" }),
            });
          } catch {
            const failed = failRaceCourseRecalculation(
              recalculating,
              COURSE_RECALCULATION_FAILED.message,
            );
            deliver(onEvent, {
              commandId: command.commandId,
              transitionId: command.transitionId,
              operationId,
              phase: "failed",
              completed: 0,
              total: 1,
            });
            return reject(COURSE_RECALCULATION_FAILED, {
              courseScenario: "PL-S069",
              course: courseProjection({
                status: "recalculation-failed",
                accepted: failed.acceptedCourse,
                candidate: failed.candidateCourse,
                detail: failed.detail,
              }),
            });
          }
        }
        if (command.transitionId === "PL-T10") {
          try {
            const current = await conversations.readDraftRevision(command.draftId);
            if (current === undefined) return reject(UNAVAILABLE);
            const timestamp = input.identity.hlcStamp().physicalMs;
            const stamp = input.identity.hlcStamp();
            await conversations.saveDraftRevision({
              ...current,
              status: "discarded",
              raceCourseJson: current.raceCourseJson,
              updatedAtMs: timestamp,
              deviceId: await input.identity.deviceId(),
              hlcPhysicalMs: stamp.physicalMs,
              hlcCounter: stamp.counter,
            });
            return ExecutePlanTransitionRpcResultSchema.parse({
              status: "completed",
              state: await read(),
            });
          } catch {
            return reject(PERSISTENCE_FAILED);
          }
        }
        return reject(UNAVAILABLE);
      });
    },
  };
}
