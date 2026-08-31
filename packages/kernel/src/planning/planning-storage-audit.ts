import type { Row, SqlReadStore } from "../store/ports.js";

export type LegacyPlanStatus = "draft" | "active" | "ended";

export interface LegacyActivePlanAuditRecord {
  readonly planId: string;
  readonly status: "active";
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly hlcPhysicalMs: number;
  readonly hlcCounter: number;
}

export interface LegacyOpenConversationAuditRecord {
  readonly conversationId: string;
  readonly status: "open";
  readonly planId: string | null;
  readonly planStatus: LegacyPlanStatus | null;
  readonly replacesPlanId: string | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly hlcPhysicalMs: number;
  readonly hlcCounter: number;
}

export interface LegacyProposedProposalAuditRecord {
  readonly proposalId: string;
  readonly status: "proposed";
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly hlcPhysicalMs: number;
  readonly hlcCounter: number;
}

export interface LegacyProposedProposalGroup {
  readonly planId: string;
  readonly proposals: readonly LegacyProposedProposalAuditRecord[];
}

export interface LegacyPlanningStorageAudit {
  readonly activePlans: readonly LegacyActivePlanAuditRecord[];
  readonly hasDuplicateActivePlans: boolean;
  readonly unfinishedPlanCreationCandidates: readonly LegacyOpenConversationAuditRecord[];
  readonly openConversationLifecycleAnomalies: readonly LegacyOpenConversationAuditRecord[];
  readonly proposedProposalGroups: readonly LegacyProposedProposalGroup[];
  readonly duplicateProposedProposalGroups: readonly LegacyProposedProposalGroup[];
}

export class PlanningStorageAuditError extends Error {
  constructor() {
    super("legacy planning storage audit found an invalid row");
    this.name = "PlanningStorageAuditError";
  }
}

const PLAN_STATUSES = new Set<unknown>(["draft", "active", "ended"]);

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new PlanningStorageAuditError();
  return value;
}

function nullableText(row: Row, key: string): string | null {
  const value = row[key];
  if (value !== null && typeof value !== "string") throw new PlanningStorageAuditError();
  return value;
}

function integer(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new PlanningStorageAuditError();
  }
  return value;
}

function planStatus(row: Row, key: string): LegacyPlanStatus | null {
  const value = nullableText(row, key);
  if (value !== null && !PLAN_STATUSES.has(value)) throw new PlanningStorageAuditError();
  return value as LegacyPlanStatus | null;
}

function activePlanFromRow(row: Row): LegacyActivePlanAuditRecord {
  if (text(row, "plan_status") !== "active") throw new PlanningStorageAuditError();
  return Object.freeze({
    planId: text(row, "plan_id"),
    status: "active",
    createdAtMs: integer(row, "created_at_ms"),
    updatedAtMs: integer(row, "updated_at_ms"),
    hlcPhysicalMs: integer(row, "hlc_physical_ms"),
    hlcCounter: integer(row, "hlc_counter"),
  });
}

function openConversationFromRow(row: Row): LegacyOpenConversationAuditRecord {
  if (text(row, "conversation_status") !== "open") throw new PlanningStorageAuditError();
  return Object.freeze({
    conversationId: text(row, "conversation_id"),
    status: "open",
    planId: nullableText(row, "plan_id"),
    planStatus: planStatus(row, "plan_status"),
    replacesPlanId: nullableText(row, "replaces_plan_id"),
    createdAtMs: integer(row, "created_at_ms"),
    updatedAtMs: integer(row, "updated_at_ms"),
    hlcPhysicalMs: integer(row, "hlc_physical_ms"),
    hlcCounter: integer(row, "hlc_counter"),
  });
}

function proposedProposalFromRow(row: Row): LegacyProposedProposalAuditRecord {
  if (text(row, "proposal_status") !== "proposed") throw new PlanningStorageAuditError();
  return Object.freeze({
    proposalId: text(row, "proposal_id"),
    status: "proposed",
    createdAtMs: integer(row, "created_at_ms"),
    updatedAtMs: integer(row, "updated_at_ms"),
    hlcPhysicalMs: integer(row, "hlc_physical_ms"),
    hlcCounter: integer(row, "hlc_counter"),
  });
}

export async function auditLegacyPlanningStorage(
  store: SqlReadStore,
): Promise<LegacyPlanningStorageAudit> {
  const activePlanRows = await store.all(
    `SELECT id AS plan_id, status AS plan_status, created_at_ms, updated_at_ms,
hlc_physical_ms, hlc_counter
FROM plan
WHERE status='active'
ORDER BY updated_at_ms DESC, hlc_physical_ms DESC, hlc_counter DESC, id DESC`,
  );
  const conversationRows = await store.all(
    `SELECT conversation.id AS conversation_id, conversation.status AS conversation_status,
conversation.plan_id, conversation.replaces_plan_id, plan.status AS plan_status,
conversation.created_at_ms, conversation.updated_at_ms,
conversation.hlc_physical_ms, conversation.hlc_counter
FROM plan_conversation AS conversation
LEFT JOIN plan ON plan.id=conversation.plan_id
WHERE conversation.status='open'
ORDER BY conversation.created_at_ms DESC, conversation.updated_at_ms DESC,
conversation.hlc_physical_ms DESC, conversation.hlc_counter DESC, conversation.id DESC`,
  );
  const proposalRows = await store.all(
    `SELECT id AS proposal_id, plan_id, status AS proposal_status, created_at_ms, updated_at_ms,
hlc_physical_ms, hlc_counter
FROM plan_proposal
WHERE status='proposed'
ORDER BY plan_id, created_at_ms DESC, updated_at_ms DESC,
hlc_physical_ms DESC, hlc_counter DESC, id DESC`,
  );

  const activePlans = Object.freeze(activePlanRows.map(activePlanFromRow));
  const openConversations = conversationRows.map(openConversationFromRow);
  const unfinishedPlanCreationCandidates = Object.freeze(
    openConversations.filter(
      (conversation) => conversation.planStatus === null || conversation.planStatus === "draft",
    ),
  );
  const openConversationLifecycleAnomalies = Object.freeze(
    openConversations.filter(
      (conversation) => conversation.planStatus === "active" || conversation.planStatus === "ended",
    ),
  );

  const proposedProposalGroups: Array<{
    readonly planId: string;
    readonly proposals: LegacyProposedProposalAuditRecord[];
  }> = [];
  for (const row of proposalRows) {
    const planId = text(row, "plan_id");
    const proposal = proposedProposalFromRow(row);
    const currentGroup = proposedProposalGroups.at(-1);
    if (currentGroup?.planId === planId) {
      currentGroup.proposals.push(proposal);
      continue;
    }
    proposedProposalGroups.push({ planId, proposals: [proposal] });
  }
  const frozenProposalGroups = Object.freeze(
    proposedProposalGroups.map((group) =>
      Object.freeze({ planId: group.planId, proposals: Object.freeze(group.proposals) }),
    ),
  );

  return Object.freeze({
    activePlans,
    hasDuplicateActivePlans: activePlans.length > 1,
    unfinishedPlanCreationCandidates,
    openConversationLifecycleAnomalies,
    proposedProposalGroups: frozenProposalGroups,
    duplicateProposedProposalGroups: Object.freeze(
      frozenProposalGroups.filter((group) => group.proposals.length > 1),
    ),
  });
}
