import {
  PlanActiveProjectionDataSchema,
  PlanChatOriginatedResultProjectionDataSchema,
  PlanEndedProjectionDataSchema,
  PlanCoachProjectionDataSchema,
  PlanReadModelSchema,
  type ChatQueueSnapshot,
  type CoachDecisionReadModel,
  type PlanAttention,
  type PlanActiveProjectionData,
  type PlanningRequestReadModel,
  type PlanEndedProjectionData,
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
import { orderPlanAttentionItems } from "@enduragent/engine";

export type ActivePlanScenario =
  | "PL-S004"
  | "PL-S005"
  | "PL-S006"
  | "PL-S009"
  | "PL-S012"
  | "PL-S074"
  | "PL-S075"
  | "PL-S076"
  | "PL-S077"
  | "PL-S078"
  | "PL-S098"
  | "PL-S007"
  | "PL-S008"
  | "PL-S013"
  | "PL-S021"
  | "PL-S022"
  | "PL-S023"
  | "PL-S024"
  | "PL-S025"
  | "PL-S026"
  | "PL-S027"
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
  | "PL-S051"
  | "PL-S090"
  | "PL-S091"
  | "PL-S092"
  | "PL-S093"
  | "PL-S097"
  | "PL-S101"
  | "PL-S100"
  | "PL-S082"
  | "PL-S083"
  | "PL-S084"
  | "PL-S085"
  | "PL-S086"
  | "PL-S087"
  | "PL-S088";

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
  readonly replacementConfirmation?: boolean;
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
    if (replacement && input.replacementConfirmation === true) {
      return {
        scenarioId: "PL-S081",
        lifecycle: "replacement-draft",
        projection: "draft",
        title: "Replace the active Plan?",
        summary: "The old Plan ends and the replacement activates locally together. Today stays.",
        transitions: [guard("PL-T26"), guard("PL-T39")],
      };
    }
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
    replacesPlanId: conversation.replacesPlanId,
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

export function buildEndedPlanConversationReadModel(input: {
  readonly conversation: PlanConversationProjection;
  readonly turns: readonly PlanConversationTurnProjection[];
  readonly planId: string;
  readonly revision: number;
}): PlanReadModel {
  return PlanReadModelSchema.parse({
    schemaVersion: 1,
    scenarioId: "PL-S102",
    lifecycle: "ended",
    planId: input.planId,
    revision: input.revision,
    title: "Plan conversation",
    summary: "This ended Plan conversation is read-only and remains in Plan History.",
    projection: "coach",
    transitions: [guard("PL-T39")],
    reconciliation: EMPTY_RECONCILIATION,
    attention: EMPTY_ATTENTION,
    activeOperation: null,
    data: PlanCoachProjectionDataSchema.parse({
      conversationId: input.conversation.id,
      chatId: `plan:${input.conversation.id}`,
      sourceConversationId: input.conversation.sourceConversationId,
      replacement: input.conversation.replacesPlanId !== null,
      replacesPlanId: input.conversation.replacesPlanId,
      readyToCreateDraft: false,
      messages: messages(input.conversation.id, input.turns),
      queue: { schemaVersion: 1, revision: 0, items: [] },
      decision: null,
      draft: null,
    }),
  });
}

export function buildChatOriginatedPlanResultReadModel(input: {
  readonly request: PlanningRequestReadModel;
  readonly planId: string | null;
  readonly lifecycle: PlanLifecycle;
  readonly revision: number;
}): PlanReadModel {
  const terminal = input.request.terminalResult;
  if (terminal === null) throw new TypeError("Chat-originated Plan result requires completion.");
  const returnTarget = input.request.source.available
    ? {
        destination: "chat" as const,
        chatId: input.request.source.chatId,
        messageId: input.request.source.messageId,
      }
    : null;
  return PlanReadModelSchema.parse({
    schemaVersion: 1,
    scenarioId: "PL-S099",
    lifecycle: input.lifecycle,
    planId: input.planId,
    revision: input.revision,
    title: terminal.title,
    summary: terminal.detail,
    projection: "proposal",
    transitions: [...(returnTarget === null ? [] : [guard("PL-T37")]), guard("PL-T39")],
    reconciliation: EMPTY_RECONCILIATION,
    attention: EMPTY_ATTENTION,
    activeOperation: null,
    data: PlanChatOriginatedResultProjectionDataSchema.parse({
      request: input.request,
      returnTarget,
    }),
  });
}

export function buildActivePlanReadModel(input: {
  readonly scenarioId: ActivePlanScenario;
  readonly planId: string;
  readonly revision: number;
  readonly data: PlanActiveProjectionData;
  readonly reconciliation: PlanReconciliation;
  readonly attentionCreatedAtMs?: number;
  readonly proposalCapabilities?: {
    readonly canRevise: boolean;
    readonly canVerifyPremises: boolean;
    readonly canCalculateLoad: boolean;
  };
}): PlanReadModel {
  const copy = {
    "PL-S004": ["Plan active", "This week reflects your Plan and completed activities."],
    "PL-S005": ["Plan history", "Plan changes are immutable and ordered newest first."],
    "PL-S006": ["Season", "Every Plan week, phase, status, purpose, and planned time."],
    "PL-S009": ["Race week", "The complete final Plan week and fixed goal race."],
    "PL-S012": ["Race readiness", "Modeled ranges and the evidence behind them."],
    "PL-S074": ["Race readiness", "The current goal is at risk under today’s evidence."],
    "PL-S075": ["Race readiness", "The course finish-time estimate is unavailable."],
    "PL-S076": ["Race readiness", "Recent training Load is unavailable."],
    "PL-S077": ["Race readiness", "The finish-time assumptions changed."],
    "PL-S078": ["Race readiness", "A hard taper-week addition was not applied."],
    "PL-S098": ["Race readiness", "Refreshing recent training Load."],
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
    "PL-S026": ["Undo expired", "This change remains in History and cannot be undone."],
    "PL-S027": ["Plan change undone", "The previous local Workout values are restored."],
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
    "PL-S051": [
      "End this Plan?",
      "Today's workout stays; tomorrow-onward Enduragent workouts will be removed.",
    ],
    "PL-S090": ["Plan settings", "Changes save immediately."],
    "PL-S091": ["Plan settings", "Saving this setting."],
    "PL-S092": ["Plan settings", "This setting is saved."],
    "PL-S093": ["Plan settings", "The previous value was restored."],
    "PL-S097": ["Proposal rejected", "The active Plan did not change."],
    "PL-S101": ["Plan updated", "An eligible future Workout reduction was applied automatically."],
    "PL-S100": ["Weekly review", "Last week’s Plan and completed activities in plain words."],
    "PL-S082": [
      "Replacement active locally",
      "Old Plan cleanup must verify before replacement calendar writing starts.",
    ],
    "PL-S083": [
      "Old Plan cleanup needs attention",
      "The replacement stays active locally while calendar writing is blocked.",
    ],
    "PL-S084": ["Retrying old Plan cleanup", "Replacement calendar writing remains blocked."],
    "PL-S085": ["Old cleanup verified", "The replacement rolling window is ready to write."],
    "PL-S086": ["Writing replacement calendar", "Writing today plus the next six days."],
    "PL-S087": ["Replacement complete", "Plan history records the local swap and verified mirror."],
    "PL-S088": ["Plan active", "The replacement Plan and its seven-day mirror are current."],
  } as const;
  const attentionItems: PlanAttention["items"] = [];
  if (input.scenarioId === "PL-S039" || input.scenarioId === "PL-S041") {
    attentionItems.push({
      id: `reconciliation:${input.planId}`,
      title: "Calendar update needs attention",
      scenarioId: input.scenarioId,
      priority: "dated",
      affectedDate: input.data.today,
      createdAtMs: input.attentionCreatedAtMs ?? 0,
    });
  }
  if (input.scenarioId === "PL-S083") {
    attentionItems.push({
      id: `replacement-cleanup:${input.planId}`,
      title: "Old Plan cleanup needs attention",
      scenarioId: "PL-S083",
      priority: "blocker",
      affectedDate: null,
      createdAtMs: input.data.replacement?.activatedAtMs ?? input.attentionCreatedAtMs ?? 0,
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
        createdAtMs: workout.drift.detectedAtMs,
      });
    }
    if (workout.match?.requiresConfirmation !== true) continue;
    attentionItems.push({
      id: `workout-match:${workout.id}`,
      title: `Confirm ${workout.name}`,
      scenarioId: "PL-S021",
      priority: "dated",
      affectedDate: workout.date,
      createdAtMs: workout.match.createdAtMs,
    });
  }
  for (const proposal of input.data.proposals ?? []) {
    attentionItems.push({
      id: `proposal:${proposal.id}`,
      title: proposal.stale ? "Review updated Plan change" : proposal.title,
      scenarioId: proposal.stale ? "PL-S025" : "PL-S007",
      priority: "dated",
      affectedDate: proposal.affectedDate,
      createdAtMs: proposal.createdAtMs,
    });
  }
  const orderedAttentionItems = orderPlanAttentionItems(attentionItems);
  const attention: PlanAttention = {
    count: orderedAttentionItems.length,
    destination:
      orderedAttentionItems.length === 0
        ? "none"
        : orderedAttentionItems.length === 1
          ? "direct"
          : "list",
    items: [...orderedAttentionItems],
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
  const canUndo = input.data.history?.some((entry) => entry.undoStatus === "eligible") === true;
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
      ...(canUndo ? [guard("PL-T21")] : []),
      guard("PL-T22"),
      guard("PL-T23"),
      guard("PL-T25"),
      guard("PL-T31"),
      guard("PL-T32"),
      ...(input.data.weeklyReview?.status === "due" ? [guard("PL-T35")] : []),
      ...(input.scenarioId === "PL-S083" ? [guard("PL-T27")] : []),
      ...(input.scenarioId === "PL-S085" ? [guard("PL-T28")] : []),
      guard("PL-T39"),
    ],
    reconciliation: input.reconciliation,
    attention,
    activeOperation: null,
    data: PlanActiveProjectionDataSchema.parse(input.data),
  });
}

export type EndedPlanScenario =
  | "PL-S014"
  | "PL-S052"
  | "PL-S053"
  | "PL-S054"
  | "PL-S055"
  | "PL-S056"
  | "PL-S089"
  | "PL-S094"
  | "PL-S095"
  | "PL-S096";

export function buildEndedPlanReadModel(input: {
  readonly scenarioId: EndedPlanScenario;
  readonly planId: string;
  readonly revision: number;
  readonly data: PlanEndedProjectionData;
  readonly reconciliation: PlanReconciliation;
}): PlanReadModel {
  const copy = {
    "PL-S014": ["Plan ended", "This Plan is saved in History and no longer changes training."],
    "PL-S052": ["Plan ended", "Removing tomorrow-onward Enduragent workouts from Intervals."],
    "PL-S053": ["Cleanup needs attention", "The Plan is ended, but some calendar cleanup remains."],
    "PL-S054": ["Checking Intervals", "Verifying that no future Enduragent workouts remain."],
    "PL-S055": ["Retrying cleanup", "Removing only the remaining Plan-owned workouts."],
    "PL-S056": ["Plan ended", "Calendar cleanup is verified."],
    "PL-S089": ["Plan ended", "Calendar cleanup is verified and Plan history is saved."],
    "PL-S094": ["Plan completed", "The Plan ended automatically after its final date."],
    "PL-S095": ["Race outcome", "Record the result separately from the ended Plan."],
    "PL-S096": ["Race not completed", "The ended Plan and training history remain saved."],
  } as const;
  const failed = input.scenarioId === "PL-S053";
  return PlanReadModelSchema.parse({
    schemaVersion: 1,
    scenarioId: input.scenarioId,
    lifecycle: "ended",
    planId: input.planId,
    revision: input.revision,
    title: copy[input.scenarioId][0],
    summary: copy[input.scenarioId][1],
    projection: "ended",
    transitions: [
      ...(failed ? [guard("PL-T24")] : []),
      ...(input.reconciliation.status === "verified" ? [guard("PL-T01")] : []),
      ...(input.scenarioId === "PL-S089" || input.scenarioId === "PL-S094"
        ? [guard("PL-T39")]
        : []),
      ...(input.scenarioId === "PL-S095" ? [guard("PL-T30")] : []),
    ],
    reconciliation: input.reconciliation,
    attention: failed
      ? {
          count: 1,
          destination: "direct",
          items: [
            {
              id: `cleanup:${input.planId}`,
              title: "Calendar cleanup needs attention",
              scenarioId: "PL-S053",
              priority: "blocker",
              affectedDate: null,
              createdAtMs: input.data.endedAtMs,
            },
          ],
        }
      : EMPTY_ATTENTION,
    activeOperation: null,
    data: PlanEndedProjectionDataSchema.parse(input.data),
  });
}
