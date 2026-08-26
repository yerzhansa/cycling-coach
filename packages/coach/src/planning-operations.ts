import {
  ExecutePlanTransitionRpcParamsSchema,
  ExecutePlanTransitionRpcResultSchema,
  GetPlanStateRpcParamsSchema,
  GetPlanStateRpcResultSchema,
  PlanDraftPlanProjectionSchema,
  PlanActiveProjectionDataSchema,
  PlanDraftProjectionSchema,
  PlanFtpProjectionSchema,
  PlanRaceCourseProjectionSchema,
  PlanStartDateProjectionSchema,
  PlanProgressEventSchema,
  PlanReadModelSchema,
  type ChatQueueRunResult,
  type ChatQueueSnapshot,
  type CoachEngine,
  type ExecutePlanTransitionRpcParams,
  type ExecutePlanTransitionRpcResult,
  type PlanDraftProjection,
  type PlanActiveProjectionData,
  type PlanDraftPlanProjection,
  type PlanError,
  type PlanFtpProjection,
  type PlanProgressEvent,
  type PlanProposalProjection,
  type PlanRaceCourseProjection,
  type PlanRaceCourseSummary,
  type PlanStartDateProjection,
  type PlanReadModel,
  type PlanningOperations,
  type TurnEvent,
} from "@enduragent/coach-contract";
import {
  activatePlanDraft,
  acceptParsedRaceCourse,
  beginRaceCourseParsing,
  beginRaceCourseRemoval,
  completeRaceCourseRecalculation,
  executePlanFtpTransition,
  failRaceCourseRecalculation,
  openRaceCoursePicker,
  previewPlanStartDate,
  projectPlanReconciliation,
  reconcileActivePlanWindow,
  rejectRaceCourseFile,
  useRouteWithoutElevation,
  verifyPlanMirror,
  projectWorkoutMatches,
  refreshPlanWorkoutMatches,
  adoptProviderWorkoutEdit,
  refreshPlanWorkoutDrifts,
  restorePlanWorkout,
  PlanWorkoutDriftError,
  type ProjectedWorkoutMatch,
  type PlanMirrorCalendarPort,
  type PlanReconciliationProjection,
  type PlanFtpAdapter,
  type PlanFtpSnapshot,
  type PlanStartDatePreview,
  type RaceCourseRecalculatingState,
  type PlanWorkoutDriftSnapshot,
  applyValidatedPlanProposal,
  capturePlanProposalBase,
  encodePlanProposalBase,
  encodePlanProposalMutation,
  parsePlanProposalMutation,
  projectPlanProposalDiff,
  revalidatePlanProposalPremises,
  validatePlanProposal,
  PlanProposalError,
  type PlanProposalLoadCalculator,
  type PlanProposalMutation,
  type PlanProposalPremiseReader,
} from "@enduragent/engine";
import {
  buildActivePlanReadModel,
  buildPlanLifecycleReadModel,
  type ActivePlanScenario,
} from "./planning-lifecycle.js";
import {
  addCivilDays,
  createPlanConversationRepository,
  createPlanReconciliationRepository,
  createPlanRepository,
  createPlanWorkoutMatchRepository,
  createPlanWorkoutDriftRepository,
  createPlanProposalRepository,
  planWeekIndex,
  PlanConversationValidationError,
  type PlanConversationRecord,
  type PlanConversationRepository,
  type PlanConversationTurnRecord,
  type PlanDraftRevisionRecord,
  type PlanRecord,
  type PlanReconciliationRepository,
  type PlanRepository,
  type PlanWorkoutRecord,
  type PlanWorkoutMatchRepository,
  type PlanWorkoutDriftRecord,
  type PlanWorkoutDriftRepository,
  type PlanProposalRecord,
  type PlanProposalPremiseRecord,
  type PlanProposalRepository,
  PlanProposalValidationError,
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

const WORKOUT_DRIFT_PROVIDER_FAILED: PlanError = Object.freeze({
  code: "provider-failed",
  message: "Couldn’t update this workout. Nothing was changed; try again.",
  retryable: true,
});

const WORKOUT_DRIFT_CHANGED: PlanError = Object.freeze({
  code: "conflict",
  message: "This workout changed again in Intervals. Review the latest version before choosing.",
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

const CALENDAR_UPDATE_FAILED: PlanError = Object.freeze({
  code: "provider-failed",
  message: "Some workouts could not be updated in Intervals.",
  retryable: true,
});

const CALENDAR_VERIFICATION_FAILED: PlanError = Object.freeze({
  code: "verification-failed",
  message: "Intervals does not match the active Plan yet.",
  retryable: true,
});

const DRAFT_STALE: PlanError = Object.freeze({
  code: "stale-base",
  message: "This Draft changed before approval. Review the latest Draft.",
  retryable: false,
});

const PROPOSAL_STALE: PlanError = Object.freeze({
  code: "stale-base",
  message: "The Plan changed before approval. Review the updated Proposal.",
  retryable: false,
});

const PROPOSAL_INVALID: PlanError = Object.freeze({
  code: "invalid-input",
  message: "This Proposal could not be applied safely. The active Plan is unchanged.",
  retryable: false,
});

function isProposalStale(error: unknown): boolean {
  return (
    (error instanceof PlanProposalError && error.code === "stale-base") ||
    (error instanceof PlanProposalValidationError && error.code === "stale-base")
  );
}

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

export interface PlanProposalRevisionBuild {
  readonly title: string;
  readonly rationale: string;
  readonly confidence: PlanProposalRecord["confidence"];
  readonly mutation: PlanProposalMutation;
  readonly premises: readonly Omit<
    PlanProposalPremiseRecord,
    "id" | "proposalId" | "createdAtMs" | "deviceId" | "hlcPhysicalMs" | "hlcCounter"
  >[];
}

export interface PlanProposalReviser {
  revise(input: {
    readonly proposal: PlanProposalRecord;
    readonly premises: readonly PlanProposalPremiseRecord[];
    readonly plan: PlanRecord;
    readonly workouts: readonly PlanWorkoutRecord[];
    readonly instruction: string;
  }): Promise<PlanProposalRevisionBuild>;
}

export interface CreatePlanningOperationsDependencies {
  readonly conversations?: PlanConversationRepository;
  readonly plans?: PlanRepository;
  readonly draftBuilder?: PlanDraftBuilder;
  readonly isReady?: (input: PlanReadinessInput) => boolean | Promise<boolean>;
  readonly ftp?: PlanFtpAdapter;
  readonly course?: PlanRaceCourseAdapter;
  readonly reconciliations?: PlanReconciliationRepository;
  readonly calendar?: PlanMirrorCalendarPort;
  readonly workoutMatches?: PlanWorkoutMatchRepository;
  readonly workoutDrifts?: PlanWorkoutDriftRepository;
  readonly proposals?: PlanProposalRepository;
  readonly proposalReviser?: PlanProposalReviser;
  readonly proposalPremiseReader?: PlanProposalPremiseReader;
  readonly proposalLoadCalculator?: PlanProposalLoadCalculator;
  readonly workoutDriftCalendar?: PlanMirrorCalendarPort;
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

function proposalProjection(input: {
  readonly proposal: PlanProposalRecord;
  readonly premises: readonly PlanProposalPremiseRecord[];
  readonly mutation: PlanProposalMutation;
  readonly stale: boolean;
  readonly error?: PlanError | null;
}): PlanProposalProjection {
  const first = input.mutation.changes[0];
  if (first === undefined) throw new PlanProposalError("invalid-mutation");
  return {
    id: input.proposal.id,
    revision: input.proposal.revision,
    title: input.proposal.title,
    rationale: input.proposal.rationale,
    confidence: input.proposal.confidence,
    targetWorkoutId: first.workoutId,
    affectedDate: dateText(first.after.dateKey),
    stale: input.stale,
    diff: [...projectPlanProposalDiff(input.mutation)],
    premises: input.premises.map((premise) => ({
      id: premise.id,
      sourceType: premise.sourceType,
      sourceId: premise.sourceId,
      sourceLabel: premise.sourceLabel,
      sourceDate: premise.sourceDateKey === null ? null : dateText(premise.sourceDateKey),
      confidence: premise.confidence,
      snapshotJson: premise.snapshotJson,
    })),
    error: input.error ?? null,
  };
}

function activePlanData(input: {
  readonly plan: PlanRecord;
  readonly workouts: readonly PlanWorkoutRecord[];
  readonly todayDateKey: number;
  readonly matchRows: readonly ProjectedWorkoutMatch[];
  readonly matchSync: {
    readonly lastSuccessfulSyncAtMs: number | null;
    readonly awaitingSync: boolean;
  };
  readonly selectedWorkoutId?: string | null;
  readonly drifts: readonly PlanWorkoutDriftRecord[];
  readonly driftError?: PlanError | null;
  readonly proposals: readonly PlanProposalProjection[];
  readonly selectedProposalId?: string | null;
  readonly proposalRevisionText?: string | null;
}): PlanActiveProjectionData {
  const plan = draftPlanProjection(input.plan, input.workouts);
  if (plan === null) throw new TypeError("An active Plan projection requires a Plan.");
  const week = planWeekIndex(input.plan, input.todayDateKey);
  const weekIndex =
    week.kind === "inside" ? week.weekIndex : week.side === "before" ? 1 : input.plan.totalWeeks;
  const weekStartDateKey =
    week.kind === "inside"
      ? addCivilDays(input.plan.startDateKey, (weekIndex - 1) * 7)
      : week.side === "before"
        ? input.plan.startDateKey
        : addCivilDays(input.plan.startDateKey, (input.plan.totalWeeks - 1) * 7);
  const windowEndDateKey = addCivilDays(weekStartDateKey, 6);
  const matchByWorkout = new Map(
    input.matchRows
      .filter(
        (row): row is ProjectedWorkoutMatch & { readonly workoutId: string } =>
          row.workoutId !== null,
      )
      .map((row) => [row.workoutId, row]),
  );
  const driftByWorkout = new Map(input.drifts.map((drift) => [drift.planWorkoutId, drift]));
  const parsedDriftSnapshot = (value: string): PlanWorkoutDriftSnapshot =>
    JSON.parse(value) as PlanWorkoutDriftSnapshot;
  const workouts = input.workouts
    .filter((workout) => workout.dateKey >= weekStartDateKey && workout.dateKey <= windowEndDateKey)
    .map((workout) => {
      const match = matchByWorkout.get(workout.id);
      const drift = driftByWorkout.get(workout.id);
      return {
        id: workout.id,
        date: dateText(workout.dateKey),
        sport: workout.sport,
        name: workout.name,
        durationS: workout.durationS,
        ...(match === undefined
          ? {}
          : {
              match: {
                kind: "planned" as const,
                status: match.status,
                activityId: match.activityId,
                matchId: match.matchId,
                actualDate: match.actualDateKey === null ? null : dateText(match.actualDateKey),
                actualDurationS: match.actualDurationS,
                requiresConfirmation: match.requiresConfirmation,
              },
            }),
        ...(drift === undefined
          ? {}
          : {
              drift: {
                status: "detected" as const,
                eventId: String(drift.providerEventId),
                plan: {
                  date: dateText(parsedDriftSnapshot(drift.planSnapshotJson).dateKey),
                  name: parsedDriftSnapshot(drift.planSnapshotJson).name,
                  durationS: parsedDriftSnapshot(drift.planSnapshotJson).durationS,
                },
                provider: {
                  date: dateText(parsedDriftSnapshot(drift.providerSnapshotJson).dateKey),
                  name: parsedDriftSnapshot(drift.providerSnapshotJson).name,
                  durationS: parsedDriftSnapshot(drift.providerSnapshotJson).durationS,
                },
                error: input.selectedWorkoutId === workout.id ? (input.driftError ?? null) : null,
              },
            }),
      };
    });
  const extra = input.matchRows
    .filter(
      (
        row,
      ): row is ProjectedWorkoutMatch & {
        readonly workoutId: null;
        readonly activityId: string;
        readonly actualDateKey: number;
      } => row.workoutId === null && row.activityId !== null && row.actualDateKey !== null,
    )
    .map((row) => ({
      id: row.activityId,
      date: dateText(row.actualDateKey),
      sport: row.actualSport ?? "activity",
      name: row.actualSport === "cycling" ? "Extra ride" : "Extra activity",
      durationS: row.actualDurationS,
      match: {
        kind: "extra" as const,
        status: "extra" as const,
        activityId: row.activityId,
        matchId: null,
        actualDate: dateText(row.actualDateKey),
        actualDurationS: row.actualDurationS,
        requiresConfirmation: false,
      },
    }));
  const allWorkouts = [...workouts, ...extra].sort(
    (left, right) => left.date.localeCompare(right.date) || left.id.localeCompare(right.id),
  );
  return PlanActiveProjectionDataSchema.parse({
    plan,
    today: dateText(input.todayDateKey),
    weekIndex,
    todayWorkout: workouts.find((workout) => workout.date === dateText(input.todayDateKey)) ?? null,
    workouts: allWorkouts,
    matchSync: input.matchSync,
    selectedWorkoutId: input.selectedWorkoutId ?? null,
    proposals: input.proposals,
    selectedProposalId: input.selectedProposalId ?? null,
    proposalRevisionText: input.proposalRevisionText ?? null,
  });
}

function activeScenario(
  projection: PlanReconciliationProjection | null,
  override: ActivePlanScenario | undefined,
): ActivePlanScenario {
  if (override !== undefined) return override;
  if (projection === null) return "PL-S004";
  if (projection.job.status === "pending") return "PL-S037";
  if (projection.job.status === "verified") return "PL-S004";
  if (projection.job.status === "running" || projection.job.status === "retrying") {
    return "PL-S042";
  }
  return projection.job.failureCount > 1 ? "PL-S041" : "PL-S039";
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
  readonly activeScenario?: ActivePlanScenario;
  readonly selectedWorkoutId?: string | null;
  readonly driftError?: PlanError | null;
  readonly selectedProposalId?: string | null;
  readonly proposalRevisionText?: string | null;
  readonly proposalOverride?: PlanProposalProjection;
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
  const reconciliations =
    dependencies.reconciliations ?? createPlanReconciliationRepository(input.context.store);
  const workoutMatches =
    dependencies.workoutMatches ?? createPlanWorkoutMatchRepository(input.context.store);
  const workoutDrifts =
    dependencies.workoutDrifts ?? createPlanWorkoutDriftRepository(input.context.store);
  const proposalRepository =
    dependencies.proposals ?? createPlanProposalRepository(input.context.store);
  const enqueue = createSerializedLane();
  const refuseProposal = async (
    proposal: PlanProposalRecord,
    reason = PROPOSAL_INVALID.message,
  ): Promise<void> => {
    const stamp = input.identity.hlcStamp();
    await proposalRepository.resolve({
      id: proposal.id,
      status: "refused",
      reason,
      resolvedAtMs: stamp.physicalMs,
      deviceId: await input.identity.deviceId(),
      hlcPhysicalMs: stamp.physicalMs,
      hlcCounter: stamp.counter,
    });
  };
  const parseProposalMutationOrRefuse = async (
    proposal: PlanProposalRecord,
  ): Promise<PlanProposalMutation | null> => {
    try {
      return parsePlanProposalMutation(proposal.mutationJson);
    } catch (error) {
      if (!(error instanceof PlanProposalError)) throw error;
      await refuseProposal(proposal);
      return null;
    }
  };

  const readActive = async (
    plan: PlanRecord,
    revision: number,
    overrides: ReadOverrides,
  ): Promise<PlanReadModel> => {
    const todayDateKey = dependencies.todayDateKey?.() ?? utcTodayDateKey();
    const [workouts, job] = await Promise.all([
      plans.readWorkouts(plan.id),
      reconciliations.readLatestJob(plan.id, "mirror"),
    ]);
    const projection =
      job === undefined ? null : await projectPlanReconciliation(reconciliations, job);
    const week = planWeekIndex(plan, todayDateKey);
    const weekIndex =
      week.kind === "inside" ? week.weekIndex : week.side === "before" ? 1 : plan.totalWeeks;
    const weekStartDateKey = addCivilDays(plan.startDateKey, (weekIndex - 1) * 7);
    const matchSync = await workoutMatches.readSyncStatus();
    const refreshed = await refreshPlanWorkoutMatches({
      planId: plan.id,
      workouts,
      startDateKey: weekStartDateKey,
      endDateKey: addCivilDays(weekStartDateKey, 6),
      repository: workoutMatches,
      identity: {
        newId: () => input.identity.newUlid(),
        deviceId: () => input.identity.deviceId(),
        stamp: () => input.identity.hlcStamp(),
      },
    });
    const matchRows = projectWorkoutMatches({
      workouts: workouts.filter(
        (workout) =>
          workout.dateKey >= weekStartDateKey &&
          workout.dateKey <= addCivilDays(weekStartDateKey, 6),
      ),
      activities: refreshed.activities,
      matches: refreshed.matches,
      todayDateKey,
      awaitingSync: matchSync.awaitingSync,
    });
    let drifts = await workoutDrifts.readOpenForPlan(plan.id);
    if (dependencies.workoutDriftCalendar !== undefined) {
      try {
        const windowEndDateKey = addCivilDays(todayDateKey, 6);
        const events = await dependencies.workoutDriftCalendar.listEvents({
          startDateKey: todayDateKey,
          endDateKey: windowEndDateKey,
        });
        drifts = await refreshPlanWorkoutDrifts(
          { plan, workouts, events, todayDateKey, windowEndDateKey },
          {
            repository: workoutDrifts,
            identity: {
              newId: () => input.identity.newUlid(),
              deviceId: () => input.identity.deviceId(),
              stamp: () => input.identity.hlcStamp(),
            },
            now: () => input.identity.hlcStamp().physicalMs,
          },
        );
      } catch {
        // Provider reads are best effort; an already-detected decision stays durable and visible.
      }
    }
    const baseScenario = activeScenario(projection, undefined);
    const scenarioId =
      overrides.activeScenario ??
      (matchSync.awaitingSync && baseScenario === "PL-S004" ? "PL-S013" : baseScenario);
    const status =
      projection === null || projection.job.status === "pending"
        ? "not-started"
        : projection.job.status === "verified"
          ? "verified"
          : projection.job.status === "failed"
            ? "failed"
            : "running";
    const verificationFailure = projection?.job.lastErrorCode === "calendar-verification-failed";
    const proposalRows = await proposalRepository.readOpenForPlan(plan.id);
    const proposalProjections = (
      await Promise.all(
        proposalRows.map(async (proposal): Promise<PlanProposalProjection | null> => {
          const premises = await proposalRepository.readPremises(proposal.id);
          try {
            const validated = validatePlanProposal({
              proposal,
              premises,
              plan,
              workouts,
              todayDateKey,
              calculateWeekLoad: dependencies.proposalLoadCalculator,
            });
            return proposalProjection({
              proposal,
              premises,
              mutation: validated.mutation,
              stale: false,
            });
          } catch (error) {
            if (!(error instanceof PlanProposalError)) throw error;
            if (error.code === "missing-capability") {
              return proposalProjection({
                proposal,
                premises,
                mutation: parsePlanProposalMutation(proposal.mutationJson),
                stale: false,
                error: UNAVAILABLE,
              });
            }
            if (error.code !== "stale-base") {
              await refuseProposal(proposal);
              return null;
            }
            try {
              return proposalProjection({
                proposal,
                premises,
                mutation: parsePlanProposalMutation(proposal.mutationJson),
                stale: true,
                error: PROPOSAL_STALE,
              });
            } catch {
              await refuseProposal(proposal);
              return null;
            }
          }
        }),
      )
    ).filter((proposal): proposal is PlanProposalProjection => proposal !== null);
    const mergedProposalProjections =
      overrides.proposalOverride === undefined
        ? proposalProjections
        : [
            overrides.proposalOverride,
            ...proposalProjections.filter(
              (proposal) => proposal.id !== overrides.proposalOverride!.id,
            ),
          ];
    return buildActivePlanReadModel({
      scenarioId,
      planId: plan.id,
      revision,
      data: activePlanData({
        plan,
        workouts,
        todayDateKey,
        matchRows,
        matchSync,
        selectedWorkoutId: overrides.selectedWorkoutId,
        drifts,
        driftError: overrides.driftError,
        proposals: mergedProposalProjections,
        selectedProposalId: overrides.selectedProposalId,
        proposalRevisionText: overrides.proposalRevisionText,
      }),
      reconciliation: {
        status,
        created: projection?.created ?? 0,
        pending: projection?.pending ?? 0,
        failed: projection?.failed ?? 0,
        total: projection?.total ?? 0,
        currentThrough:
          projection?.job.status === "verified" ? dateText(projection.job.windowEndDateKey) : null,
        error:
          status === "failed"
            ? verificationFailure
              ? CALENDAR_VERIFICATION_FAILED
              : CALENDAR_UPDATE_FAILED
            : null,
      },
      proposalCapabilities: {
        canRevise: dependencies.proposalReviser !== undefined,
        canVerifyPremises: dependencies.proposalPremiseReader !== undefined,
        canCalculateLoad: dependencies.proposalLoadCalculator !== undefined,
      },
    });
  };

  const read = async (overrides: ReadOverrides = {}): Promise<PlanReadModel> => {
    const conversation = await conversations.readLatestOpenConversation();
    if (conversation === undefined) {
      const latestPlan = await plans.readLatest();
      if (latestPlan?.status === "active") return readActive(latestPlan, 0, overrides);
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
    const projectedPlanId = draft?.planId ?? conversation.planId;
    const draftPlan = projectedPlanId === null ? undefined : await plans.read(projectedPlanId);
    const draftWorkouts = draftPlan === undefined ? [] : await plans.readWorkouts(draftPlan.id);
    if (draftPlan?.status === "active") {
      return readActive(draftPlan, draft?.revision ?? 0, overrides);
    }
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

  const saveProposalRevision = async (inputValue: {
    readonly current: PlanProposalRecord;
    readonly premises: readonly PlanProposalPremiseRecord[];
    readonly plan: PlanRecord;
    readonly workouts: readonly PlanWorkoutRecord[];
    readonly instruction: string;
  }): Promise<PlanProposalRecord> => {
    if (dependencies.proposalReviser === undefined)
      throw new Error("Proposal revision unavailable.");
    const build = await dependencies.proposalReviser.revise({
      proposal: inputValue.current,
      premises: inputValue.premises,
      plan: inputValue.plan,
      workouts: inputValue.workouts,
      instruction: inputValue.instruction,
    });
    const timestamp = input.identity.hlcStamp().physicalMs;
    const stamp = input.identity.hlcStamp();
    const deviceId = await input.identity.deviceId();
    const next: PlanProposalRecord = {
      id: input.identity.newUlid(),
      planId: inputValue.plan.id,
      parentProposalId: inputValue.current.id,
      revision: inputValue.current.revision + 1,
      status: "proposed",
      title: build.title,
      rationale: build.rationale,
      confidence: build.confidence,
      mutationJson: encodePlanProposalMutation(build.mutation),
      baseSnapshotJson: encodePlanProposalBase(
        capturePlanProposalBase(inputValue.plan, inputValue.workouts),
      ),
      refusalReason: null,
      createdAtMs: timestamp,
      updatedAtMs: timestamp,
      resolvedAtMs: null,
      deviceId,
      hlcPhysicalMs: stamp.physicalMs,
      hlcCounter: stamp.counter,
    };
    const premiseRecords = build.premises.map(
      (premise): PlanProposalPremiseRecord => ({
        ...premise,
        id: input.identity.newUlid(),
        proposalId: next.id,
        createdAtMs: timestamp,
        deviceId,
        hlcPhysicalMs: stamp.physicalMs,
        hlcCounter: stamp.counter,
      }),
    );
    validatePlanProposal({
      proposal: next,
      premises: premiseRecords,
      plan: inputValue.plan,
      workouts: inputValue.workouts,
      todayDateKey: dependencies.todayDateKey?.() ?? utcTodayDateKey(),
      calculateWeekLoad: dependencies.proposalLoadCalculator,
    });
    return proposalRepository.save(next, premiseRecords);
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
        if (command.transitionId === "PL-T11") {
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
            const activation = await activatePlanDraft(
              {
                draftRevisionId: command.draftId,
                expectedRevision: command.expectedRevision,
              },
              { drafts: conversations, identity: input.identity },
            );
            const plan = await plans.read(activation.planId);
            if (plan === undefined || plan.status !== "active")
              throw new Error("Plan activation failed.");
            const todayDateKey = dependencies.todayDateKey?.() ?? utcTodayDateKey();
            const stamp = input.identity.hlcStamp();
            await reconciliations
              .createOrGetJob({
                id: input.identity.newUlid(),
                planId: plan.id,
                kind: "mirror",
                windowStartDateKey: todayDateKey,
                windowEndDateKey: addCivilDays(todayDateKey, 6),
                createdAtMs: stamp.physicalMs,
              })
              .catch(() => undefined);
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
            return reject(
              error instanceof PlanConversationValidationError &&
                (error.code === "stale-draft" || error.code === "plan-not-draft")
                ? DRAFT_STALE
                : PERSISTENCE_FAILED,
            );
          }
        }
        if (command.transitionId === "PL-T12") {
          if (dependencies.calendar === undefined) return reject(UNAVAILABLE);
          const plan = await plans.read(command.planId);
          if (plan === undefined || plan.status !== "active") return reject(UNAVAILABLE);
          const todayDateKey = dependencies.todayDateKey?.() ?? utcTodayDateKey();
          const workouts = await plans.readWorkouts(plan.id);
          const existingJob = await reconciliations.readLatestJob(plan.id, "mirror");
          const existingItems =
            existingJob === undefined ? [] : await reconciliations.readItems(existingJob.id);
          const total = Math.max(existingItems.length, 1);
          const operationId = input.identity.newUlid();
          deliver(onEvent, {
            commandId: command.commandId,
            transitionId: command.transitionId,
            operationId,
            phase: "running",
            completed: 0,
            total,
          });
          try {
            const reconcilerDependencies = {
              repository: reconciliations,
              calendar: dependencies.calendar,
              identity: { newId: () => input.identity.newUlid() },
              now: () => input.identity.hlcStamp().physicalMs,
            };
            const result =
              command.mode === "verify" && existingJob !== undefined && existingItems.length > 0
                ? await verifyPlanMirror(existingJob, reconcilerDependencies)
                : await reconcileActivePlanWindow(
                    { plan, workouts, todayDateKey },
                    reconcilerDependencies,
                  );
            if (result.job.status === "failed") {
              deliver(onEvent, {
                commandId: command.commandId,
                transitionId: command.transitionId,
                operationId,
                phase: "failed",
                completed: Math.min(result.created, Math.max(result.total, 1)),
                total: Math.max(result.total, 1),
              });
              const error =
                result.job.lastErrorCode === "calendar-verification-failed"
                  ? CALENDAR_VERIFICATION_FAILED
                  : CALENDAR_UPDATE_FAILED;
              return reject(error);
            }
            deliver(onEvent, {
              commandId: command.commandId,
              transitionId: command.transitionId,
              operationId,
              phase: "completed",
              completed: Math.max(result.total, 1),
              total: Math.max(result.total, 1),
            });
            return ExecutePlanTransitionRpcResultSchema.parse({
              status: "completed",
              state: await read({ activeScenario: "PL-S043" }),
            });
          } catch {
            deliver(onEvent, {
              commandId: command.commandId,
              transitionId: command.transitionId,
              operationId,
              phase: "failed",
              completed: 0,
              total,
            });
            return reject(CALENDAR_UPDATE_FAILED);
          }
        }
        if (command.transitionId === "PL-T13") {
          const [plan, workout] = await Promise.all([
            plans.read(command.planId),
            plans
              .readWorkouts(command.planId)
              .then((workouts) => workouts.find((candidate) => candidate.id === command.workoutId)),
          ]);
          if (plan?.status !== "active") return reject(UNAVAILABLE);
          if (workout === undefined) {
            const current = await read();
            const data = PlanActiveProjectionDataSchema.safeParse(current.data);
            if (
              !data.success ||
              !data.data.workouts.some((candidate) => candidate.id === command.workoutId)
            ) {
              return reject(UNAVAILABLE);
            }
          }
          const drift =
            workout === undefined
              ? undefined
              : await workoutDrifts.readOpenForWorkout(command.workoutId);
          return ExecutePlanTransitionRpcResultSchema.parse({
            status: "completed",
            state: await read({
              activeScenario: drift === undefined ? "PL-S021" : "PL-S032",
              selectedWorkoutId: command.workoutId,
            }),
          });
        }
        if (command.transitionId === "PL-T14") {
          const plan = await plans.read(command.planId);
          if (plan?.status !== "active") return reject(UNAVAILABLE);
          const candidate = (await workoutMatches.readForWorkout(command.workoutId)).find(
            (match) => match.activityId === command.activityId && match.decision === "suggested",
          );
          if (candidate === undefined) return reject(UNAVAILABLE);
          try {
            const stamp = input.identity.hlcStamp();
            await workoutMatches.decide({
              id: candidate.id,
              decision: command.decision === "reject" ? "rejected" : "confirmed",
              decidedAtMs: stamp.physicalMs,
              deviceId: await input.identity.deviceId(),
              hlcPhysicalMs: stamp.physicalMs,
              hlcCounter: stamp.counter,
            });
            return ExecutePlanTransitionRpcResultSchema.parse({
              status: "completed",
              state: await read({ activeScenario: "PL-S004", selectedWorkoutId: null }),
            });
          } catch {
            return reject(PERSISTENCE_FAILED, {
              activeScenario: "PL-S021",
              selectedWorkoutId: command.workoutId,
            });
          }
        }
        if (command.transitionId === "PL-T15" || command.transitionId === "PL-T16") {
          const eventId = Number(command.eventId);
          if (
            dependencies.workoutDriftCalendar === undefined ||
            !Number.isSafeInteger(eventId) ||
            eventId <= 0
          )
            return reject(UNAVAILABLE);
          const todayDateKey = dependencies.todayDateKey?.() ?? utcTodayDateKey();
          const driftDependencies = {
            repository: workoutDrifts,
            plans,
            calendar: dependencies.workoutDriftCalendar,
            identity: {
              newId: () => input.identity.newUlid(),
              deviceId: () => input.identity.deviceId(),
              stamp: () => input.identity.hlcStamp(),
            },
            now: () => input.identity.hlcStamp().physicalMs,
          };
          try {
            if (command.transitionId === "PL-T15") {
              await adoptProviderWorkoutEdit(
                {
                  planId: command.planId,
                  workoutId: command.workoutId,
                  eventId,
                  todayDateKey,
                },
                driftDependencies,
              );
            } else {
              await restorePlanWorkout(
                {
                  planId: command.planId,
                  workoutId: command.workoutId,
                  eventId,
                  todayDateKey,
                },
                driftDependencies,
              );
            }
            return ExecutePlanTransitionRpcResultSchema.parse({
              status: "completed",
              state: await read({
                activeScenario: command.transitionId === "PL-T15" ? "PL-S034" : "PL-S036",
                selectedWorkoutId: command.workoutId,
              }),
            });
          } catch (error) {
            const driftError =
              error instanceof PlanWorkoutDriftError && error.code === "invalid-provider-event"
                ? WORKOUT_DRIFT_CHANGED
                : WORKOUT_DRIFT_PROVIDER_FAILED;
            return reject(driftError, {
              activeScenario: "PL-S032",
              selectedWorkoutId: command.workoutId,
              driftError,
            });
          }
        }
        if (command.transitionId === "PL-T17") {
          const [proposal, plan] = await Promise.all([
            proposalRepository.read(command.proposalId),
            plans.read(command.planId),
          ]);
          if (
            proposal?.status !== "proposed" ||
            plan?.status !== "active" ||
            proposal.planId !== plan.id
          ) {
            return reject(UNAVAILABLE);
          }
          const [workouts, premises] = await Promise.all([
            plans.readWorkouts(plan.id),
            proposalRepository.readPremises(proposal.id),
          ]);
          try {
            const validated = validatePlanProposal({
              proposal,
              premises,
              plan,
              workouts,
              todayDateKey: dependencies.todayDateKey?.() ?? utcTodayDateKey(),
              calculateWeekLoad: dependencies.proposalLoadCalculator,
            });
            return ExecutePlanTransitionRpcResultSchema.parse({
              status: "completed",
              state: await read({
                activeScenario: "PL-S007",
                selectedProposalId: proposal.id,
                proposalOverride: proposalProjection({
                  proposal,
                  premises,
                  mutation: validated.mutation,
                  stale: false,
                }),
              }),
            });
          } catch (error) {
            if (!(error instanceof PlanProposalError)) throw error;
            if (error.code === "missing-capability") {
              return ExecutePlanTransitionRpcResultSchema.parse({
                status: "completed",
                state: await read({
                  activeScenario: "PL-S007",
                  selectedProposalId: proposal.id,
                  proposalOverride: proposalProjection({
                    proposal,
                    premises,
                    mutation: parsePlanProposalMutation(proposal.mutationJson),
                    stale: false,
                    error: UNAVAILABLE,
                  }),
                }),
              });
            }
            if (error.code === "stale-base") {
              const projected = proposalProjection({
                proposal,
                premises,
                mutation: parsePlanProposalMutation(proposal.mutationJson),
                stale: true,
                error: PROPOSAL_STALE,
              });
              return ExecutePlanTransitionRpcResultSchema.parse({
                status: "completed",
                state: await read({
                  activeScenario: "PL-S025",
                  selectedProposalId: proposal.id,
                  proposalOverride: projected,
                }),
              });
            }
            await refuseProposal(proposal);
            return ExecutePlanTransitionRpcResultSchema.parse({
              status: "completed",
              state: await read({ activeScenario: "PL-S097" }),
            });
          }
        }
        if (command.transitionId === "PL-T18") {
          if (dependencies.proposalReviser === undefined) return reject(UNAVAILABLE);
          const proposal = await proposalRepository.read(command.proposalId);
          if (proposal?.status !== "proposed") return reject(UNAVAILABLE);
          const mutation = await parseProposalMutationOrRefuse(proposal);
          if (mutation === null) {
            return ExecutePlanTransitionRpcResultSchema.parse({
              status: "completed",
              state: await read({ activeScenario: "PL-S097" }),
            });
          }
          if (mutation.weekLoad !== null && dependencies.proposalLoadCalculator === undefined) {
            return reject(UNAVAILABLE);
          }
          const [plan, workouts, premises] = await Promise.all([
            plans.read(proposal.planId),
            plans.readWorkouts(proposal.planId),
            proposalRepository.readPremises(proposal.id),
          ]);
          if (plan?.status !== "active") return reject(UNAVAILABLE);
          try {
            const revised = await saveProposalRevision({
              current: proposal,
              premises,
              plan,
              workouts,
              instruction: command.text,
            });
            return ExecutePlanTransitionRpcResultSchema.parse({
              status: "completed",
              state: await read({
                activeScenario: "PL-S023",
                selectedProposalId: revised.id,
                proposalRevisionText: command.text,
              }),
            });
          } catch (error) {
            if (error instanceof PlanProposalError && error.code === "missing-capability") {
              return reject(UNAVAILABLE, {
                activeScenario: "PL-S007",
                selectedProposalId: proposal.id,
              });
            }
            return reject(PERSISTENCE_FAILED, {
              activeScenario: "PL-S022",
              selectedProposalId: proposal.id,
              proposalRevisionText: command.text,
            });
          }
        }
        if (command.transitionId === "PL-T19") {
          const proposal = await proposalRepository.read(command.proposalId);
          if (proposal?.status !== "proposed" || proposal.revision !== command.expectedRevision) {
            return reject(PROPOSAL_STALE);
          }
          const mutation = await parseProposalMutationOrRefuse(proposal);
          if (mutation === null) {
            return ExecutePlanTransitionRpcResultSchema.parse({
              status: "completed",
              state: await read({ activeScenario: "PL-S097" }),
            });
          }
          const [plan, workouts, premises] = await Promise.all([
            plans.read(proposal.planId),
            plans.readWorkouts(proposal.planId),
            proposalRepository.readPremises(proposal.id),
          ]);
          if (plan?.status !== "active") return reject(UNAVAILABLE);
          const premiseReader = dependencies.proposalPremiseReader;
          if (premiseReader === undefined) return reject(UNAVAILABLE);
          if (mutation.weekLoad !== null && dependencies.proposalLoadCalculator === undefined) {
            return reject(UNAVAILABLE);
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
          try {
            await revalidatePlanProposalPremises(premises, premiseReader);
            const todayDateKey = dependencies.todayDateKey?.() ?? utcTodayDateKey();
            const validated = validatePlanProposal({
              proposal,
              premises,
              plan,
              workouts,
              todayDateKey,
              calculateWeekLoad: dependencies.proposalLoadCalculator,
            });
            const stamp = input.identity.hlcStamp();
            await applyValidatedPlanProposal(validated, {
              repository: proposalRepository,
              plan,
              resolvedAtMs: stamp.physicalMs,
              deviceId: await input.identity.deviceId(),
              hlcPhysicalMs: stamp.physicalMs,
              hlcCounter: stamp.counter,
              mirrorJob: {
                id: input.identity.newUlid(),
                windowStartDateKey: todayDateKey,
                windowEndDateKey: addCivilDays(todayDateKey, 6),
                createdAtMs: stamp.physicalMs,
              },
            });
          } catch (error) {
            if (error instanceof PlanProposalError && error.code === "missing-capability") {
              deliver(onEvent, {
                commandId: command.commandId,
                transitionId: command.transitionId,
                operationId,
                phase: "failed",
                completed: 0,
                total: 1,
              });
              return reject(UNAVAILABLE, {
                activeScenario: "PL-S007",
                selectedProposalId: proposal.id,
              });
            }
            if (isProposalStale(error)) {
              let current = proposal;
              if (dependencies.proposalReviser !== undefined) {
                try {
                  const latestPlan = await plans.read(proposal.planId);
                  if (latestPlan?.status !== "active") throw new Error("Plan is not active.");
                  const [latestWorkouts, refreshedPremises] = await Promise.all([
                    plans.readWorkouts(proposal.planId),
                    Promise.all(
                      premises.map(async (premise) => {
                        const snapshotJson = await premiseReader.read({
                          sourceType: premise.sourceType,
                          sourceId: premise.sourceId,
                        });
                        if (snapshotJson === null) throw new Error("Proposal premise is missing.");
                        return Object.freeze({ ...premise, snapshotJson });
                      }),
                    ),
                  ]);
                  current = await saveProposalRevision({
                    current: proposal,
                    premises: refreshedPremises,
                    plan: latestPlan,
                    workouts: latestWorkouts,
                    instruction:
                      "Revalidate this Proposal against the current Plan and source data without changing the athlete's intent.",
                  });
                } catch {
                  current = proposal;
                }
              }
              const currentPremises = await proposalRepository.readPremises(current.id);
              const projected = proposalProjection({
                proposal: current,
                premises: currentPremises,
                mutation: parsePlanProposalMutation(current.mutationJson),
                stale: current.id === proposal.id,
                error: current.id === proposal.id ? PROPOSAL_STALE : null,
              });
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
                  activeScenario: "PL-S025",
                  selectedProposalId: current.id,
                  proposalOverride: projected,
                }),
              });
            }
            deliver(onEvent, {
              commandId: command.commandId,
              transitionId: command.transitionId,
              operationId,
              phase: "failed",
              completed: 0,
              total: 1,
            });
            return reject(PROPOSAL_INVALID, {
              activeScenario: "PL-S007",
              selectedProposalId: proposal.id,
            });
          }
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
            state: await read({ activeScenario: "PL-S008" }),
          });
        }
        if (command.transitionId === "PL-T20") {
          const proposal = await proposalRepository.read(command.proposalId);
          if (proposal?.status !== "proposed") return reject(UNAVAILABLE);
          const stamp = input.identity.hlcStamp();
          await proposalRepository.resolve({
            id: proposal.id,
            status: "rejected",
            resolvedAtMs: stamp.physicalMs,
            deviceId: await input.identity.deviceId(),
            hlcPhysicalMs: stamp.physicalMs,
            hlcCounter: stamp.counter,
          });
          return ExecutePlanTransitionRpcResultSchema.parse({
            status: "completed",
            state: await read({ activeScenario: "PL-S097" }),
          });
        }
        if (command.transitionId === "PL-T33") {
          const state = await read();
          if (state.planId !== command.planId || state.attention.count === 0) {
            return reject(UNAVAILABLE);
          }
          if (state.attention.destination === "direct") {
            const item = state.attention.items[0]!;
            if (item.id.startsWith("workout-match:")) {
              return ExecutePlanTransitionRpcResultSchema.parse({
                status: "completed",
                state: await read({
                  activeScenario: "PL-S021",
                  selectedWorkoutId: item.id.slice("workout-match:".length),
                }),
              });
            }
            if (item.id.startsWith("workout-drift:")) {
              return ExecutePlanTransitionRpcResultSchema.parse({
                status: "completed",
                state: await read({
                  activeScenario: "PL-S032",
                  selectedWorkoutId: item.id.slice("workout-drift:".length),
                }),
              });
            }
            if (item.id.startsWith("proposal:")) {
              const proposalId = item.id.slice("proposal:".length);
              const proposal = await proposalRepository.read(proposalId);
              if (proposal?.status !== "proposed") return reject(UNAVAILABLE);
              return ExecutePlanTransitionRpcResultSchema.parse({
                status: "completed",
                state: await read({
                  activeScenario: item.scenarioId === "PL-S025" ? "PL-S025" : "PL-S007",
                  selectedProposalId: proposalId,
                }),
              });
            }
            return ExecutePlanTransitionRpcResultSchema.parse({ status: "completed", state });
          }
          return ExecutePlanTransitionRpcResultSchema.parse({
            status: "completed",
            state: PlanReadModelSchema.parse({
              ...state,
              scenarioId: "PL-S028",
              projection: "attention",
              title: "Plan attention",
              summary: `${state.attention.count} items need your decision.`,
            }),
          });
        }
        if (command.transitionId === "PL-T34") {
          const isMatch = command.attentionId.startsWith("workout-match:");
          const isDrift = command.attentionId.startsWith("workout-drift:");
          const isProposal = command.attentionId.startsWith("proposal:");
          if (!isMatch && !isDrift && !isProposal) return reject(UNAVAILABLE);
          const plan = await plans.readLatest();
          if (plan?.status !== "active") return reject(UNAVAILABLE);
          if (isProposal) {
            const proposalId = command.attentionId.slice("proposal:".length);
            const proposal = await proposalRepository.read(proposalId);
            if (proposal?.status !== "proposed" || proposal.planId !== plan.id) {
              return reject(UNAVAILABLE);
            }
            const premises = await proposalRepository.readPremises(proposal.id);
            let scenario: ActivePlanScenario = "PL-S007";
            try {
              validatePlanProposal({
                proposal,
                premises,
                plan,
                workouts: await plans.readWorkouts(plan.id),
                todayDateKey: dependencies.todayDateKey?.() ?? utcTodayDateKey(),
                calculateWeekLoad: dependencies.proposalLoadCalculator,
              });
            } catch (error) {
              if (error instanceof PlanProposalError && error.code === "stale-base") {
                scenario = "PL-S025";
              }
            }
            return ExecutePlanTransitionRpcResultSchema.parse({
              status: "completed",
              state: await read({ activeScenario: scenario, selectedProposalId: proposalId }),
            });
          }
          const workoutId = command.attentionId.slice(
            isMatch ? "workout-match:".length : "workout-drift:".length,
          );
          const workout = (await plans.readWorkouts(plan.id)).find(
            (candidate) => candidate.id === workoutId,
          );
          if (workout === undefined) return reject(UNAVAILABLE);
          return ExecutePlanTransitionRpcResultSchema.parse({
            status: "completed",
            state: await read({
              activeScenario: isMatch ? "PL-S021" : "PL-S032",
              selectedWorkoutId: workoutId,
            }),
          });
        }
        return reject(UNAVAILABLE);
      });
    },
  };
}
