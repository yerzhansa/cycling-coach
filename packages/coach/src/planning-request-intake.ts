import { canonicalJson } from "@enduragent/kernel/archive";
import {
  addCivilDays,
  planWeekIndex,
  type PlanConversationRecord,
  type PlanConversationRepository,
  type PlanProposalPremiseRecord,
  type PlanProposalRecord,
  type PlanRecord,
  type PlanRepository,
  type PlanningRequestIntakeRepository,
  type PlanningRequestRecord,
  type PlanningRequestRepository,
} from "@enduragent/kernel/planning";
import type { AuthoredIdentity } from "@enduragent/kernel-node/home";
import {
  capturePlanProposalBase,
  encodePlanProposalBase,
  encodePlanProposalMutation,
  validatePlanProposal,
  type PlanProposalPremiseReader,
} from "@enduragent/engine";
import {
  parseNormalizedWorkoutSet,
  type NormalizedWorkout,
  type WorkoutParserLimits,
} from "@enduragent/sport-cycling/workout-import";

export interface PlanningRequestIntakeServiceInput {
  readonly requests: PlanningRequestRepository;
  readonly intake: PlanningRequestIntakeRepository;
  readonly plans: PlanRepository;
  readonly conversations: PlanConversationRepository;
  readonly identity: AuthoredIdentity;
  readonly workoutLimits: WorkoutParserLimits;
  readonly todayDateKey: () => number;
}

function selectedWorkout(
  record: PlanningRequestRecord,
  limits: WorkoutParserLimits,
): NormalizedWorkout | null {
  const payload = record.sourceState.payload;
  const snapshot = payload?.sourceSnapshot.selectedWorkout;
  const attachment = payload?.sourceSnapshot.attachment;
  if (
    snapshot === null ||
    snapshot === undefined ||
    attachment === null ||
    attachment === undefined
  ) {
    return null;
  }
  const set = parseNormalizedWorkoutSet(
    {
      schemaVersion: 1,
      setId: snapshot.setId,
      sourceFormat: attachment.extension,
      parserVersion: "planning-request-snapshot",
      selectedWorkoutId: snapshot.workoutId,
      workouts: [snapshot.workout],
      diagnostics: [],
    },
    limits,
  );
  const workout = set.workouts.find((candidate) => candidate.workoutId === snapshot.workoutId);
  if (workout === undefined) throw new TypeError("The selected Workout snapshot is missing.");
  return workout;
}

function chooseDate(input: {
  readonly plan: PlanRecord;
  readonly workouts: readonly { readonly dateKey: number }[];
  readonly requestedDateKey: number | null;
  readonly todayDateKey: number;
}): {
  readonly dateKey: number;
  readonly attention: "needs_review" | "date_conflict";
  readonly resolvedDateKey: number | null;
} {
  const occupied = new Set(input.workouts.map((workout) => workout.dateKey));
  const requestedEligible =
    input.requestedDateKey !== null &&
    input.requestedDateKey > input.todayDateKey &&
    planWeekIndex(input.plan, input.requestedDateKey).kind === "inside";
  if (requestedEligible && input.requestedDateKey !== null) {
    return occupied.has(input.requestedDateKey)
      ? { dateKey: input.requestedDateKey, attention: "date_conflict", resolvedDateKey: null }
      : {
          dateKey: input.requestedDateKey,
          attention: "needs_review",
          resolvedDateKey: input.requestedDateKey,
        };
  }
  let dateKey = input.plan.startDateKey;
  if (dateKey <= input.todayDateKey) dateKey = addCivilDays(input.todayDateKey, 1);
  while (planWeekIndex(input.plan, dateKey).kind === "inside") {
    if (!occupied.has(dateKey)) {
      return { dateKey, attention: "needs_review", resolvedDateKey: dateKey };
    }
    dateKey = addCivilDays(dateKey, 1);
  }
  throw new TypeError("The active Plan has no eligible date for this Workout.");
}

async function conversationFor(
  input: PlanningRequestIntakeServiceInput,
  record: PlanningRequestRecord,
): Promise<{ readonly conversation: PlanConversationRecord; readonly create: boolean }> {
  const latestPlan = await input.plans.readLatest();
  if (
    (record.request.target === "active_plan" && latestPlan?.status === "active") ||
    (record.request.target === "draft" && latestPlan?.status === "draft")
  ) {
    const existing = await input.conversations.readConversationByPlanId(latestPlan.id);
    if (existing !== undefined) {
      if (existing.status !== "open") throw new TypeError("The Plan conversation has ended.");
      return { conversation: existing, create: false };
    }
    const stamp = input.identity.hlcStamp();
    return {
      conversation: {
        id: input.identity.newUlid(),
        planId: latestPlan.id,
        replacesPlanId: null,
        courseChoiceStatus: "undecided",
        raceCourseJson: null,
        status: "open",
        endedAtMs: null,
        createdAtMs: stamp.physicalMs,
        updatedAtMs: stamp.physicalMs,
        deviceId: await input.identity.deviceId(),
        hlcPhysicalMs: stamp.physicalMs,
        hlcCounter: stamp.counter,
      },
      create: true,
    };
  }
  const existing = await input.conversations.readLatestOpenConversation();
  if (existing !== undefined && existing.planId === null && existing.replacesPlanId === null) {
    return { conversation: existing, create: false };
  }
  const stamp = input.identity.hlcStamp();
  return {
    conversation: {
      id: input.identity.newUlid(),
      planId: null,
      replacesPlanId: null,
      courseChoiceStatus: "undecided",
      raceCourseJson: null,
      status: "open",
      endedAtMs: null,
      createdAtMs: stamp.physicalMs,
      updatedAtMs: stamp.physicalMs,
      deviceId: await input.identity.deviceId(),
      hlcPhysicalMs: stamp.physicalMs,
      hlcCounter: stamp.counter,
    },
    create: true,
  };
}

async function bindConversation(
  input: PlanningRequestIntakeServiceInput,
  record: PlanningRequestRecord,
): Promise<void> {
  const payload = record.sourceState.payload;
  if (payload === null) throw new TypeError("The Planning request source was compacted.");
  const destination = await conversationFor(input, record);
  const stamp = input.identity.hlcStamp();
  const deviceId = await input.identity.deviceId();
  await input.intake.accept({
    requestId: record.request.requestId,
    expectedRevision: record.request.revision,
    destination: {
      kind: "conversation",
      conversation: destination.conversation,
      createConversation: destination.create,
      sourceRequest: {
        id: input.identity.newUlid(),
        conversationId: destination.conversation.id,
        sourceChatId: payload.source.chatId,
        sourceBoundaryRef: null,
        sourceMessageId: payload.source.messageId,
        requestJson: canonicalJson(payload),
        createdAtMs: stamp.physicalMs,
        updatedAtMs: stamp.physicalMs,
        deviceId,
        hlcPhysicalMs: stamp.physicalMs,
        hlcCounter: stamp.counter,
      },
    },
    updatedAtMs: stamp.physicalMs,
    deviceId,
    hlcPhysicalMs: stamp.physicalMs,
    hlcCounter: stamp.counter,
  });
}

async function bindProposal(
  input: PlanningRequestIntakeServiceInput,
  record: PlanningRequestRecord,
  workout: NormalizedWorkout,
): Promise<void> {
  const payload = record.sourceState.payload;
  const attachment = payload?.sourceSnapshot.attachment;
  const workoutSnapshot = payload?.sourceSnapshot.selectedWorkout;
  const plan = await input.plans.readLatest();
  if (
    payload === null ||
    attachment === null ||
    attachment === undefined ||
    workoutSnapshot === null ||
    workoutSnapshot === undefined ||
    plan?.status !== "active"
  ) {
    throw new TypeError("The active Plan request is incomplete.");
  }
  const workouts = await input.plans.readWorkouts(plan.id);
  const date = chooseDate({
    plan,
    workouts,
    requestedDateKey: record.request.requestedDateKey,
    todayDateKey: input.todayDateKey(),
  });
  const stamp = input.identity.hlcStamp();
  const deviceId = await input.identity.deviceId();
  const proposalId = input.identity.newUlid();
  const proposal: PlanProposalRecord = {
    id: proposalId,
    planId: plan.id,
    parentProposalId: null,
    revision: 1,
    status: "proposed",
    title: `Add ${workout.title}`,
    rationale: workout.purpose ?? payload.intent,
    confidence: "Moderate",
    mutationJson: encodePlanProposalMutation({
      schemaVersion: 1,
      changes: [
        {
          workoutId: input.identity.newUlid(),
          before: null,
          after: {
            dateKey: date.dateKey,
            sport: workout.sport,
            name: workout.title,
            durationS: workout.durationSeconds,
            structureJson: canonicalJson({
              schemaVersion: 1,
              sourceFormat: attachment.extension,
              setId: workoutSnapshot.setId,
              workout,
            }),
          },
        },
      ],
      weekLoad: null,
    }),
    baseSnapshotJson: encodePlanProposalBase(capturePlanProposalBase(plan, workouts)),
    refusalReason: null,
    createdAtMs: stamp.physicalMs,
    updatedAtMs: stamp.physicalMs,
    resolvedAtMs: null,
    deviceId,
    hlcPhysicalMs: stamp.physicalMs,
    hlcCounter: stamp.counter,
  };
  const premise: PlanProposalPremiseRecord = {
    id: input.identity.newUlid(),
    proposalId,
    sourceType: "planning_request",
    sourceId: record.request.requestId,
    sourceLabel: attachment.displayName,
    sourceDateKey: record.request.requestedDateKey,
    confidence: "Moderate",
    snapshotJson: canonicalJson(payload),
    createdAtMs: stamp.physicalMs,
    deviceId,
    hlcPhysicalMs: stamp.physicalMs,
    hlcCounter: stamp.counter,
  };
  if (date.attention === "needs_review") {
    validatePlanProposal({
      proposal,
      premises: [premise],
      plan,
      workouts,
      todayDateKey: input.todayDateKey(),
    });
  }
  await input.intake.accept({
    requestId: record.request.requestId,
    expectedRevision: record.request.revision,
    destination: {
      kind: "proposal",
      proposal,
      premises: [premise],
      attention: date.attention,
      resolvedDateKey: date.resolvedDateKey,
    },
    updatedAtMs: stamp.physicalMs,
    deviceId,
    hlcPhysicalMs: stamp.physicalMs,
    hlcCounter: stamp.counter,
  });
}

export function createPlanningRequestIntakeService(input: PlanningRequestIntakeServiceInput) {
  return async (record: PlanningRequestRecord): Promise<PlanningRequestRecord> => {
    if (
      record.request.lifecycle !== "open" ||
      record.request.planConversationId !== null ||
      record.request.proposalId !== null
    ) {
      return record;
    }
    const workout = selectedWorkout(record, input.workoutLimits);
    if (record.request.target === "active_plan" && workout !== null) {
      await bindProposal(input, record, workout);
    } else {
      await bindConversation(input, record);
    }
    const accepted = await input.requests.read(record.request.requestId);
    if (accepted === undefined) throw new TypeError("The Planning request intake was not stored.");
    return accepted;
  };
}

export function createPlanningRequestPremiseReader(
  requests: PlanningRequestRepository,
): PlanProposalPremiseReader {
  return {
    async read(source) {
      if (source.sourceType !== "planning_request") return null;
      const record = await requests.read(source.sourceId);
      const payload = record?.sourceState.payload;
      return payload === null || payload === undefined ? null : canonicalJson(payload);
    },
  };
}
