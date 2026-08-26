import {
  PlanCoachProjectionDataSchema,
  PlanReadModelSchema,
  type ChatQueueSnapshot,
  type CoachDecisionReadModel,
  type PlanAttention,
  type PlanCoachMessage,
  type PlanDraftProjection,
  type PlanFtpProjection,
  type PlanLifecycle,
  type PlanProjectionKind,
  type PlanRaceCourseProjection,
  type PlanReadModel,
  type PlanScenarioId,
  type PlanTransitionGuard,
} from "@enduragent/coach-contract";

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
