import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { auditLegacyPlanningStorage } from "@enduragent/kernel/planning";
import { runMigrations, type MigratorStore, type SqlStore } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { openSqliteStorage } from "../src/sqlite/index.js";

const id = (suffix: number): string => String(suffix).padStart(26, "0");
const REDACTED_VALUE = "sensitive-athlete-value";

async function insertPlan(
  store: SqlStore,
  input: {
    readonly id: string;
    readonly status: "draft" | "active" | "ended";
    readonly createdAtMs: number;
    readonly updatedAtMs: number;
  },
): Promise<void> {
  await store.run(
    `INSERT INTO plan (
  id,origin_id,name,primary_goal,start_date_key,target_date_key,status,kind,total_weeks,
  week_start_day,structure_json,created_at_ms,updated_at_ms,device_id,hlc_physical_ms,hlc_counter
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      input.id,
      null,
      REDACTED_VALUE,
      REDACTED_VALUE,
      19980824,
      null,
      input.status,
      "short_race_preparation",
      4,
      1,
      JSON.stringify({ prescription: REDACTED_VALUE }),
      input.createdAtMs,
      input.updatedAtMs,
      "device-1",
      input.updatedAtMs,
      0,
    ],
  );
}

async function insertConversation(
  store: SqlStore,
  input: {
    readonly id: string;
    readonly planId: string | null;
    readonly replacesPlanId?: string | null;
    readonly status?: "open" | "ended";
    readonly createdAtMs: number;
  },
): Promise<void> {
  const status = input.status ?? "open";
  const updatedAtMs = input.createdAtMs + 1;
  await store.run(
    `INSERT INTO plan_conversation (
  id,plan_id,replaces_plan_id,status,ended_at_ms,created_at_ms,updated_at_ms,
  device_id,hlc_physical_ms,hlc_counter
) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [
      input.id,
      input.planId,
      input.replacesPlanId ?? null,
      status,
      status === "ended" ? updatedAtMs : null,
      input.createdAtMs,
      updatedAtMs,
      "device-1",
      updatedAtMs,
      0,
    ],
  );
}

async function insertProposal(
  store: SqlStore,
  input: {
    readonly id: string;
    readonly planId: string;
    readonly status?: "proposed" | "applied";
    readonly createdAtMs: number;
  },
): Promise<void> {
  const status = input.status ?? "proposed";
  const updatedAtMs = input.createdAtMs + 1;
  await store.run(
    `INSERT INTO plan_proposal (
  id,plan_id,parent_proposal_id,revision,status,title,rationale,confidence,mutation_json,
  base_snapshot_json,refusal_reason,created_at_ms,updated_at_ms,resolved_at_ms,
  device_id,hlc_physical_ms,hlc_counter
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      input.id,
      input.planId,
      null,
      1,
      status,
      REDACTED_VALUE,
      REDACTED_VALUE,
      "High",
      JSON.stringify({ mutation: REDACTED_VALUE }),
      JSON.stringify({ snapshot: REDACTED_VALUE }),
      null,
      input.createdAtMs,
      updatedAtMs,
      status === "applied" ? updatedAtMs : null,
      "device-1",
      updatedAtMs,
      0,
    ],
  );
}

describe("legacy Planning storage audit", () => {
  let store: SqlStore & MigratorStore;

  beforeEach(async () => {
    store = openSqliteStorage(":memory:");
    await runMigrations(store, MIGRATIONS);
  });

  afterEach(async () => {
    await store.close();
  });

  it("returns an empty deterministic report for an empty Planning store", async () => {
    await expect(auditLegacyPlanningStorage(store)).resolves.toEqual({
      activePlans: [],
      hasDuplicateActivePlans: false,
      unfinishedPlanCreationCandidates: [],
      openConversationLifecycleAnomalies: [],
      proposedProposalGroups: [],
      duplicateProposedProposalGroups: [],
    });
  });

  it("does not flag one active Plan as a duplicate", async () => {
    await insertPlan(store, {
      id: id(1),
      status: "active",
      createdAtMs: 10,
      updatedAtMs: 20,
    });

    const audit = await auditLegacyPlanningStorage(store);

    expect(audit.activePlans).toHaveLength(1);
    expect(audit.hasDuplicateActivePlans).toBe(false);
  });

  it("classifies legacy lifecycle conflicts, groups proposals, and redacts values", async () => {
    const olderActivePlanId = id(1);
    const newerActivePlanId = id(2);
    const draftPlanId = id(3);
    const endedPlanId = id(4);
    await insertPlan(store, {
      id: olderActivePlanId,
      status: "active",
      createdAtMs: 10,
      updatedAtMs: 20,
    });
    await insertPlan(store, {
      id: newerActivePlanId,
      status: "active",
      createdAtMs: 11,
      updatedAtMs: 30,
    });
    await insertPlan(store, {
      id: draftPlanId,
      status: "draft",
      createdAtMs: 12,
      updatedAtMs: 31,
    });
    await insertPlan(store, {
      id: endedPlanId,
      status: "ended",
      createdAtMs: 13,
      updatedAtMs: 32,
    });

    const unlinkedConversationId = id(11);
    const draftConversationId = id(12);
    const activeConversationId = id(13);
    const endedConversationId = id(14);
    await insertConversation(store, {
      id: unlinkedConversationId,
      planId: null,
      replacesPlanId: olderActivePlanId,
      createdAtMs: 40,
    });
    await insertConversation(store, {
      id: draftConversationId,
      planId: draftPlanId,
      replacesPlanId: olderActivePlanId,
      createdAtMs: 50,
    });
    await insertConversation(store, {
      id: activeConversationId,
      planId: newerActivePlanId,
      createdAtMs: 60,
    });
    await insertConversation(store, {
      id: endedConversationId,
      planId: endedPlanId,
      createdAtMs: 70,
    });
    await insertConversation(store, {
      id: id(15),
      planId: null,
      status: "ended",
      createdAtMs: 80,
    });
    await store.run(
      `INSERT INTO plan_conversation_turn (
  id,conversation_id,sequence,athlete_text,coach_text,lineage_json,completed_at_ms,
  device_id,hlc_physical_ms,hlc_counter
) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [
        id(16),
        unlinkedConversationId,
        1,
        REDACTED_VALUE,
        REDACTED_VALUE,
        JSON.stringify({ answer: REDACTED_VALUE }),
        41,
        "device-1",
        41,
        0,
      ],
    );

    const newerDuplicateProposalId = id(21);
    const olderDuplicateProposalId = id(22);
    const singleProposalId = id(23);
    await insertProposal(store, {
      id: olderDuplicateProposalId,
      planId: olderActivePlanId,
      createdAtMs: 90,
    });
    await insertProposal(store, {
      id: newerDuplicateProposalId,
      planId: olderActivePlanId,
      createdAtMs: 100,
    });
    await insertProposal(store, {
      id: singleProposalId,
      planId: endedPlanId,
      createdAtMs: 110,
    });
    await insertProposal(store, {
      id: id(24),
      planId: newerActivePlanId,
      status: "applied",
      createdAtMs: 120,
    });

    const audit = await auditLegacyPlanningStorage(store);

    expect(audit).toEqual({
      activePlans: [
        {
          planId: newerActivePlanId,
          status: "active",
          createdAtMs: 11,
          updatedAtMs: 30,
          hlcPhysicalMs: 30,
          hlcCounter: 0,
        },
        {
          planId: olderActivePlanId,
          status: "active",
          createdAtMs: 10,
          updatedAtMs: 20,
          hlcPhysicalMs: 20,
          hlcCounter: 0,
        },
      ],
      hasDuplicateActivePlans: true,
      unfinishedPlanCreationCandidates: [
        {
          conversationId: draftConversationId,
          status: "open",
          planId: draftPlanId,
          planStatus: "draft",
          replacesPlanId: olderActivePlanId,
          createdAtMs: 50,
          updatedAtMs: 51,
          hlcPhysicalMs: 51,
          hlcCounter: 0,
        },
        {
          conversationId: unlinkedConversationId,
          status: "open",
          planId: null,
          planStatus: null,
          replacesPlanId: olderActivePlanId,
          createdAtMs: 40,
          updatedAtMs: 41,
          hlcPhysicalMs: 41,
          hlcCounter: 0,
        },
      ],
      openConversationLifecycleAnomalies: [
        {
          conversationId: endedConversationId,
          status: "open",
          planId: endedPlanId,
          planStatus: "ended",
          replacesPlanId: null,
          createdAtMs: 70,
          updatedAtMs: 71,
          hlcPhysicalMs: 71,
          hlcCounter: 0,
        },
        {
          conversationId: activeConversationId,
          status: "open",
          planId: newerActivePlanId,
          planStatus: "active",
          replacesPlanId: null,
          createdAtMs: 60,
          updatedAtMs: 61,
          hlcPhysicalMs: 61,
          hlcCounter: 0,
        },
      ],
      proposedProposalGroups: [
        {
          planId: olderActivePlanId,
          proposals: [
            {
              proposalId: newerDuplicateProposalId,
              status: "proposed",
              createdAtMs: 100,
              updatedAtMs: 101,
              hlcPhysicalMs: 101,
              hlcCounter: 0,
            },
            {
              proposalId: olderDuplicateProposalId,
              status: "proposed",
              createdAtMs: 90,
              updatedAtMs: 91,
              hlcPhysicalMs: 91,
              hlcCounter: 0,
            },
          ],
        },
        {
          planId: endedPlanId,
          proposals: [
            {
              proposalId: singleProposalId,
              status: "proposed",
              createdAtMs: 110,
              updatedAtMs: 111,
              hlcPhysicalMs: 111,
              hlcCounter: 0,
            },
          ],
        },
      ],
      duplicateProposedProposalGroups: [
        {
          planId: olderActivePlanId,
          proposals: [
            {
              proposalId: newerDuplicateProposalId,
              status: "proposed",
              createdAtMs: 100,
              updatedAtMs: 101,
              hlcPhysicalMs: 101,
              hlcCounter: 0,
            },
            {
              proposalId: olderDuplicateProposalId,
              status: "proposed",
              createdAtMs: 90,
              updatedAtMs: 91,
              hlcPhysicalMs: 91,
              hlcCounter: 0,
            },
          ],
        },
      ],
    });
    expect(await auditLegacyPlanningStorage(store)).toEqual(audit);
    expect(JSON.stringify(audit)).not.toContain(REDACTED_VALUE);
  });
});
