import {
  PlanActiveProjectionDataSchema,
  PlanCoachProjectionDataSchema,
  PlanReadModelSchema,
  type ChatQueueSnapshot,
  type CoachDecisionReadModel,
  type PlanAttention,
  type PlanActiveProjectionData,
  type PlanCoachMessage,
  type PlanDraftProjection,
  type PlanDraftPlanProjection,
  type PlanFtpProjection,
  type PlanLifecycle,
  type PlanProjectionKind,
  type PlanRaceCourseProjection,
  type PlanStartDateProjection,
  type PlanReconciliation,
  type PlanReadModel,
  type PlanScenarioId,
  type PlanTransitionGuard,
} from "@enduragent/coach-contract";

export type ActivePlanScenario =
  | "PL-S004"
  | "PL-S007"
  | "PL-S008"
  | "PL-S013"
  | "PL-S021"
  | "PL-S022"
  | "PL-S023"
  | "PL-S024"
  | "PL-S025"
  | "PL-S032"
  | "PL-S033"
  | "PL-S034"
  | "PL-S035"
  | "PL-S036"
  | "PL-S010"
  | "PL-S037"
  | "PL-S038"
  | "PL-S039"
  | "PL-S040"
  | "PL-S041"
  | "PL-S042"
  | "PL-S043"
  | "PL-S097";

export interface PlanConversationProjection {
  readonly id: string;
  readonly planId: string | null;
  readonly replacesPlanId: string | null;
  readonly sourceConversationId: string | null;
}

export interface PlanConversationTurnProjection {
  readonly id: string;
  readonly athleteText: string;
  readonly coachText: string;
}

export interface BuildPlanLifecycleReadModelInput {
  readonly conversation: PlanConversationProjection | null;
  readonly turns: readonly PlanConversationTurnProjection[];
  readonly readyToCreateDraft: boolean;
  readonly queue: ChatQueueSnapshot;
  readonly decision: CoachDecisionReadModel | null;
  readonly draft: PlanDraftProjection | null;
  readonly plan?: PlanDraftPlanProjection | null;
  readonly startDate?: PlanStartDateProjection;
  readonly ftp?: PlanFtpProjection | null;
  readonly ftpScenario?: "PL-S057" | "PL-S058" | "PL-S059" | "PL-S060" | "PL-S061" | "PL-S062";
  readonly course?: PlanRaceCourseProjection;
  readonly courseScenario?:
    | "PL-S064"
    | "PL-S065"
    | "PL-S067"
    | "PL-S068"
    | "PL-S069"
    | "PL-S070"
    | "PL-S104";
  readonly dateScenario?: "PL-S046" | "PL-S048" | "PL-S050";
}

const EMPTY_ATTENTION: PlanAttention = Object.freeze({
  count: 0,
  destination: "none",
  items: [],
});

const EMPTY_RECONCILIATION = Object.freeze({
  status: "not-applicable" as const,
  created: 0,
  pending: 0,
  failed: 0,
  total: 0,
  currentThrough: null,
  error: null,
});

function guard(transitionId: PlanTransitionGuard["transitionId"]): PlanTransitionGuard {
  return { transitionId, status: "available", reason: null };
}

function messages(
  conversationId: string,
  turns: readonly PlanConversationTurnProjection[],
): readonly PlanCoachMessage[] {
  return [
    {
      id: `plan-intro:${conversationId}`,
      turnId: null,
      role: "coach",
      text: "Let’s build this here in Plan. What event are you training toward?",
    },
    ...turns.flatMap((turn) => [
      {
        id: `${turn.id}:athlete`,
        turnId: turn.id,
        role: "athlete" as const,
        text: turn.athleteText,
      },
      {
        id: `${turn.id}:coach`,
        turnId: turn.id,
        role: "coach" as const,
        text: turn.coachText,
      },
    ]),
  ];
}

function stateKind(input: BuildPlanLifecycleReadModelInput): {
  readonly scenarioId: PlanScenarioId;
  readonly lifecycle: PlanLifecycle;
  readonly projection: PlanProjectionKind;
  readonly title: string;
  readonly summary: string;
  readonly transitions: readonly PlanTransitionGuard[];
} {
  const conversation = input.conversation;
  if (conversation === null) {
    return {
      scenarioId: "PL-S001",
      lifecycle: "none",
      projection: "no-plan",
      title: "Train toward one clear goal",
      summary: "Build a Plan with your coach.",
      transitions: [guard("PL-T01")],
    };
  }
  const replacement = conversation.replacesPlanId !== null;
  const draft = input.draft;
  if (draft?.status === "forming") {
    const revision = draft.revision > 1;
    return {
      scenarioId: replacement ? "PL-S105" : revision ? "PL-S030" : "PL-S018",
      lifecycle: replacement ? "replacement-draft-forming" : "draft-forming",
      projection: "draft",
      title: revision
        ? "Updating your Draft"
        : replacement
          ? "Building your replacement Draft"
          : "Building your Draft",
      summary: revision
        ? "The previous Draft stays available until this update is complete."
        : "Your Draft opens automatically when it is ready.",
      transitions: [],
    };
  }
  if (input.courseScenario !== undefined) {
    const copy = {
      "PL-S064": ["Reading Race Course", "Checking route shape, distance, and elevation."],
      "PL-S065": ["This file can’t be read", "Choose another GPX or FIT file."],
      "PL-S067": ["Route found, elevation missing", "Use the route only or choose another file."],
      "PL-S068": ["Recalculating Draft", "Your previous Draft stays available."],
      "PL-S069": ["Draft recalculation failed", "Your previous Draft is unchanged."],
      "PL-S070": ["Race Course added", "The Draft now uses this route."],
      "PL-S104": [
        "Couldn’t continue without a Race Course",
        "Nothing changed. Try again or return to your coach.",
      ],
    } as const;
    const draftVisible = draft?.status === "ready" || draft?.status === "failed";
    return {
      scenarioId: input.courseScenario,
      lifecycle: draftVisible
        ? replacement
          ? "replacement-draft"
          : "draft"
        : replacement
          ? "replacement-intake"
          : "intake",
      projection: draftVisible ? "draft" : "coach",
      title: copy[input.courseScenario][0],
      summary: copy[input.courseScenario][1],
      transitions: draftVisible
        ? [guard("PL-T07"), guard("PL-T08"), guard("PL-T09"), guard("PL-T10"), guard("PL-T11")]
        : [guard("PL-T02"), guard("PL-T03"), guard("PL-T04"), guard("PL-T05")],
    };
  }
  if (input.dateScenario !== undefined && draft !== null) {
    const copy = {
      "PL-S046": ["Choose another start date", "The current Draft is unchanged."],
      "PL-S048": ["The Plan could not be recalculated", "Your current Draft is safe."],
      "PL-S050": ["Start date updated", "Review the recalculated Draft before approval."],
    } as const;
    return {
      scenarioId: input.dateScenario,
      lifecycle: replacement ? "replacement-draft" : "draft",
      projection: "draft",
      title: copy[input.dateScenario][0],
      summary: copy[input.dateScenario][1],
      transitions: [
        guard("PL-T07"),
        guard("PL-T08"),
        guard("PL-T09"),
        guard("PL-T10"),
        guard("PL-T11"),
      ],
    };
  }
  if (draft?.status === "ready" || draft?.status === "failed") {
    const revision = draft.revision > 1;
    return {
      scenarioId: replacement ? "PL-S080" : revision ? "PL-S031" : "PL-S002",
      lifecycle: replacement ? "replacement-draft" : "draft",
      projection: "draft",
      title: replacement ? "Replacement Draft" : revision ? "Draft updated" : "Draft Plan",
      summary:
        draft.status === "failed"
          ? "The previous Draft is still available. Try the update again."
          : "Review the Draft before anything writes to your calendar.",
      transitions: [
        guard("PL-T07"),
        guard("PL-T08"),
        guard("PL-T09"),
        guard("PL-T10"),
        guard("PL-T11"),
      ],
    };
  }
  const ftpScenario =
    input.ftpScenario ??
    (input.ftp !== undefined && input.ftp?.usedSource === null ? "PL-S003" : null);
  if (ftpScenario !== null) {
    const copy = {
      "PL-S003": ["FTP required", "Add FTP before the cycling Draft can be built."],
      "PL-S057": ["Refreshing Intervals", "Checking FTP and eFTP sources."],
      "PL-S058": ["FTP required", "No FTP source was found in Intervals."],
      "PL-S059": ["FTP required", "Intervals could not be refreshed."],
      "PL-S060": ["FTP source selected", "The highest-precedence source controls this Draft."],
      "PL-S061": ["FTP required", "Enter 1–9999 whole watts."],
      "PL-S062": ["FTP accepted", "Returning to the Plan coach automatically."],
    } as const;
    return {
      scenarioId: ftpScenario,
      lifecycle: replacement ? "replacement-intake" : "intake",
      projection: "coach",
      title: copy[ftpScenario][0],
      summary: copy[ftpScenario][1],
      transitions: [guard("PL-T04")],
    };
  }
  const discarded = draft?.status === "discarded";
  const ftpReady = input.ftp === undefined || input.ftp === null || input.ftp.usedSource !== null;
  const ready = input.readyToCreateDraft && ftpReady && !discarded;
  return {
    scenarioId: discarded
      ? "PL-S020"
      : replacement
        ? ready
          ? "PL-S103"
          : "PL-S079"
        : ready
          ? "PL-S016"
          : "PL-S017",
    lifecycle: replacement ? "replacement-intake" : "intake",
    projection: "coach",
    title: discarded ? "Draft discarded" : ready ? "Ready to create Draft" : "Plan coach",
    summary: discarded
      ? "Your Plan conversation is still here."
      : ready
        ? "The coach has enough information to build your Draft."
        : "Tell your coach what you are training toward.",
    transitions: ready
      ? [guard("PL-T02"), guard("PL-T03"), guard("PL-T04"), guard("PL-T05"), guard("PL-T06")]
      : [guard("PL-T02"), guard("PL-T03"), guard("PL-T04"), guard("PL-T05")],
  };
}

export function buildPlanLifecycleReadModel(
  input: BuildPlanLifecycleReadModelInput,
): PlanReadModel {
  const kind = stateKind(input);
  if (input.conversation === null) {
    return PlanReadModelSchema.parse({
      schemaVersion: 1,
      scenarioId: kind.scenarioId,
      lifecycle: kind.lifecycle,
      planId: null,
      revision: 0,
      title: kind.title,
      summary: kind.summary,
      projection: kind.projection,
      transitions: kind.transitions,
      reconciliation: EMPTY_RECONCILIATION,
      attention: EMPTY_ATTENTION,
      activeOperation: null,
      data: {},
    });
  }
  const conversation = input.conversation;
  const data = PlanCoachProjectionDataSchema.parse({
    conversationId: conversation.id,
    chatId: `plan:${conversation.id}`,
    sourceConversationId: conversation.sourceConversationId,
    replacement: conversation.replacesPlanId !== null,
    readyToCreateDraft: input.readyToCreateDraft,
    messages: messages(conversation.id, input.turns),
    queue: input.queue,
    decision: input.decision,
    draft: input.draft,
    ...(input.plan === undefined ? {} : { plan: input.plan }),
    ...(input.startDate === undefined ? {} : { startDate: input.startDate }),
    ...(input.ftp === undefined ? {} : { ftp: input.ftp }),
    ...(input.course === undefined ? {} : { course: input.course }),
  });
  return PlanReadModelSchema.parse({
    schemaVersion: 1,
    scenarioId: kind.scenarioId,
    lifecycle: kind.lifecycle,
    planId: input.draft?.planId ?? conversation.planId,
    revision: input.draft?.revision ?? 0,
    title: kind.title,
    summary: kind.summary,
    projection: kind.projection,
    transitions: kind.transitions,
    reconciliation: EMPTY_RECONCILIATION,
    attention: EMPTY_ATTENTION,
    activeOperation: null,
    data,
  });
}

export function buildActivePlanReadModel(input: {
  readonly scenarioId: ActivePlanScenario;
  readonly planId: string;
  readonly revision: number;
  readonly data: PlanActiveProjectionData;
  readonly reconciliation: PlanReconciliation;
  readonly proposalCapabilities?: {
    readonly canRevise: boolean;
    readonly canVerifyPremises: boolean;
    readonly canCalculateLoad: boolean;
  };
}): PlanReadModel {
  const copy = {
    "PL-S004": ["Plan active", "This week reflects your Plan and completed activities."],
    "PL-S007": [
      "Plan change needs review",
      "Review the proposed change before it affects your Plan.",
    ],
    "PL-S008": ["Plan updated", "The approved change is now part of the active Plan."],
    "PL-S013": ["Plan active", "Activity matches are shown as of the last successful sync."],
    "PL-S021": ["Workout details", "Review how this workout matched an activity."],
    "PL-S022": ["Revise Proposal", "The active Plan stays unchanged while the coach revises it."],
    "PL-S023": ["Updated Proposal", "Review the revised change before approving it."],
    "PL-S024": [
      "Checking the current Plan",
      "Confirming the Proposal still matches its source data.",
    ],
    "PL-S025": [
      "Plan changed before approval",
      "Review the recalculated Proposal before approving it.",
    ],
    "PL-S032": ["Workout changed in Intervals", "Choose which version becomes authoritative."],
    "PL-S033": [
      "Updating the Plan",
      "Keeping the Intervals edit and recording it in Plan history.",
    ],
    "PL-S034": ["Intervals edit adopted", "The Plan now uses the workout from Intervals."],
    "PL-S035": [
      "Restoring Plan workout",
      "Writing the Plan workout back to Intervals and verifying it.",
    ],
    "PL-S036": ["Plan workout restored", "Intervals now matches the Plan again."],
    "PL-S010": ["Plan active", "Calendar update has not started."],
    "PL-S037": ["Plan active locally", "Intervals is ready to update."],
    "PL-S038": ["Updating Intervals", "Writing today plus the next six days."],
    "PL-S039": ["Calendar update needs attention", "Some workouts could not be written."],
    "PL-S040": ["Retrying calendar update", "Only unresolved workouts are being checked."],
    "PL-S041": ["Calendar update still needs attention", "Retry or verify the provider again."],
    "PL-S042": ["Resuming calendar update", "The interrupted update is continuing safely."],
    "PL-S043": ["Plan active", "Intervals is current for the next seven days."],
    "PL-S097": ["Proposal rejected", "The active Plan did not change."],
  } as const;
  const attentionItems: PlanAttention["items"] = [];
  if (input.scenarioId === "PL-S039" || input.scenarioId === "PL-S041") {
    attentionItems.push({
      id: `reconciliation:${input.planId}`,
      title: "Calendar update needs attention",
      scenarioId: input.scenarioId,
      priority: "dated",
      affectedDate: input.data.today,
    });
  }
  for (const workout of input.data.workouts) {
    if (workout.drift !== undefined) {
      attentionItems.push({
        id: `workout-drift:${workout.id}`,
        title: `${workout.name} changed in Intervals`,
        scenarioId: "PL-S032",
        priority: "dated",
        affectedDate: workout.date,
      });
    }
    if (workout.match?.requiresConfirmation !== true) continue;
    attentionItems.push({
      id: `workout-match:${workout.id}`,
      title: `Confirm ${workout.name}`,
      scenarioId: "PL-S021",
      priority: "dated",
      affectedDate: workout.date,
    });
  }
  for (const proposal of input.data.proposals ?? []) {
    attentionItems.push({
      id: `proposal:${proposal.id}`,
      title: proposal.stale ? "Review updated Plan change" : proposal.title,
      scenarioId: proposal.stale ? "PL-S025" : "PL-S007",
      priority: "dated",
      affectedDate: proposal.affectedDate,
    });
  }
  const attention: PlanAttention = {
    count: attentionItems.length,
    destination:
      attentionItems.length === 0 ? "none" : attentionItems.length === 1 ? "direct" : "list",
    items: attentionItems,
  };
  const selectedProposal = (input.data.proposals ?? []).find(
    (proposal) => proposal.id === input.data.selectedProposalId,
  );
  const requiresLoadCalculation =
    selectedProposal?.diff.some((line) => line.field === "week-load") ?? false;
  const canCalculateProposal =
    !requiresLoadCalculation || input.proposalCapabilities?.canCalculateLoad === true;
  const canReviseProposal = input.proposalCapabilities?.canRevise === true && canCalculateProposal;
  const canApproveProposal =
    input.proposalCapabilities?.canVerifyPremises === true &&
    canCalculateProposal &&
    (selectedProposal?.stale !== true || input.proposalCapabilities?.canRevise === true);
  return PlanReadModelSchema.parse({
    schemaVersion: 1,
    scenarioId: input.scenarioId,
    lifecycle: "active",
    planId: input.planId,
    revision: input.revision,
    title: copy[input.scenarioId][0],
    summary: copy[input.scenarioId][1],
    projection: "active",
    transitions: [
      guard("PL-T12"),
      guard("PL-T13"),
      guard("PL-T14"),
      guard("PL-T15"),
      guard("PL-T16"),
      guard("PL-T17"),
      ...(canReviseProposal ? [guard("PL-T18")] : []),
      ...(canApproveProposal ? [guard("PL-T19")] : []),
      guard("PL-T20"),
      guard("PL-T39"),
    ],
    reconciliation: input.reconciliation,
    attention,
    activeOperation: null,
    data: PlanActiveProjectionDataSchema.parse(input.data),
  });
}
