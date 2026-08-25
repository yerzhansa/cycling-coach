import type {
  PlanAttention,
  PlanError,
  PlanProjectionKind,
  PlanReadModel,
} from "@enduragent/coach-contract";

export const PLAN_ERROR: PlanError = Object.freeze({
  code: "unavailable",
  message: "Plan is temporarily unavailable.",
  retryable: true,
});

export function planAttention(count = 0): PlanAttention {
  const items = Array.from({ length: count }, (_, index) => ({
    id: `attention-${index + 1}`,
    title: `Decision ${index + 1}`,
    scenarioId: "PL-S021" as const,
    priority: index === 0 ? ("blocker" as const) : ("recent" as const),
    affectedDate: null,
  }));
  return {
    count,
    destination: count === 0 ? "none" : count === 1 ? "direct" : "list",
    items,
  };
}

export function planReadModel(input: {
  readonly attentionCount?: number;
  readonly projection?: PlanProjectionKind;
  readonly lifecycle?: PlanReadModel["lifecycle"];
  readonly scenarioId?: PlanReadModel["scenarioId"];
  readonly planId?: string | null;
  readonly title?: string;
  readonly summary?: string;
} = {}): PlanReadModel {
  return {
    schemaVersion: 1,
    scenarioId: input.scenarioId ?? "PL-S001",
    lifecycle: input.lifecycle ?? "none",
    planId: input.planId === undefined ? null : input.planId,
    revision: 0,
    title: input.title ?? "",
    summary: input.summary ?? "",
    projection: input.projection ?? "no-plan",
    transitions: [{ transitionId: "PL-T01", status: "available", reason: null }],
    reconciliation: {
      status: "not-applicable",
      created: 0,
      pending: 0,
      failed: 0,
      total: 0,
      currentThrough: null,
      error: null,
    },
    attention: planAttention(input.attentionCount),
    activeOperation: null,
    data: {},
  };
}
