import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PlanConversationValidationError,
  createPlanConversationRepository,
  createPlanRepository,
  createRaceCourseSnapshot,
  type PlanConversationRecord,
  type PlanConversationTurnRecord,
  type PlanDraftRevisionRecord,
  type PlanRecord,
  type PlanSourceRequestRecord,
} from "@enduragent/kernel/planning";
import { runMigrations, type MigratorStore, type SqlStore } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { openSqliteStorage } from "../src/sqlite/index.js";

const PLAN_ID = `${"0".repeat(25)}1`;
const REPLACED_PLAN_ID = `${"0".repeat(25)}2`;
const CONVERSATION_ID = `${"0".repeat(25)}3`;
const TURN_ID = `${"0".repeat(25)}4`;
const REVISION_ID = `${"0".repeat(25)}5`;
const SECOND_REVISION_ID = `${"0".repeat(25)}6`;
const REQUEST_ID = `${"0".repeat(25)}7`;
const SECOND_PLAN_ID = `${"0".repeat(25)}A`;
const SECOND_CONVERSATION_ID = `${"0".repeat(25)}B`;

function plan(overrides: Partial<PlanRecord> = {}): PlanRecord {
  return {
    id: PLAN_ID,
    originId: null,
    name: "Gran Fondo Plan",
    primaryGoal: "Finish in the front half",
    startDateKey: 20260709,
    targetDateKey: 20260930,
    status: "draft",
    kind: "full_plan",
    totalWeeks: 12,
    weekStartDay: 4,
    structureJson: '{"phases":[]}',
    createdAtMs: 1,
    updatedAtMs: 2,
    deviceId: "device-1",
    hlcPhysicalMs: 2,
    hlcCounter: 0,
    ...overrides,
  };
}

function conversation(overrides: Partial<PlanConversationRecord> = {}): PlanConversationRecord {
  return {
    id: CONVERSATION_ID,
    planId: null,
    replacesPlanId: null,
    courseChoiceStatus: "undecided",
    raceCourseJson: null,
    status: "open",
    endedAtMs: null,
    createdAtMs: 10,
    updatedAtMs: 10,
    deviceId: "device-1",
    hlcPhysicalMs: 10,
    hlcCounter: 0,
    ...overrides,
  };
}

function turn(overrides: Partial<PlanConversationTurnRecord> = {}): PlanConversationTurnRecord {
  return {
    id: TURN_ID,
    conversationId: CONVERSATION_ID,
    sequence: 1,
    athleteText: "Gran Fondo Almaty on 4 October.",
    coachText: "What days can you train?",
    lineageJson: '{"provider":"test","model":"test"}',
    completedAtMs: 11,
    deviceId: "device-1",
    hlcPhysicalMs: 11,
    hlcCounter: 0,
    ...overrides,
  };
}

function revision(overrides: Partial<PlanDraftRevisionRecord> = {}): PlanDraftRevisionRecord {
  return {
    id: REVISION_ID,
    conversationId: CONVERSATION_ID,
    planId: PLAN_ID,
    revision: 1,
    parentRevisionId: null,
    status: "forming",
    snapshotJson: '{"completeWeeks":1}',
    raceCourseJson: null,
    createdAtMs: 12,
    updatedAtMs: 12,
    deviceId: "device-1",
    hlcPhysicalMs: 12,
    hlcCounter: 0,
    ...overrides,
  };
}

function sourceRequest(overrides: Partial<PlanSourceRequestRecord> = {}): PlanSourceRequestRecord {
  return {
    id: REQUEST_ID,
    conversationId: CONVERSATION_ID,
    sourceChatId: "desktop",
    sourceBoundaryRef: "archive-boundary",
    sourceMessageId: "turn-42",
    requestJson: '{"intent":"create-plan"}',
    createdAtMs: 13,
    updatedAtMs: 13,
    deviceId: "device-1",
    hlcPhysicalMs: 13,
    hlcCounter: 0,
    ...overrides,
  };
}

function raceCourseJson(): string {
  return JSON.stringify(
    createRaceCourseSnapshot({
      fileName: "almaty-gran-fondo.gpx",
      route: {
        format: "gpx",
        segments: [
          {
            points: [
              { latitude: 43.2, longitude: 76.8, elevationM: 900 },
              { latitude: 43.3, longitude: 76.9, elevationM: 960 },
            ],
          },
        ],
      },
      preview: {
        pointCount: 2,
        distanceM: 14_000,
        elevationGainM: 60,
        elevationStatus: "available",
      },
    }),
  );
}

describe("Plan conversation repository", () => {
  let store: SqlStore & MigratorStore;

  beforeEach(async () => {
    store = openSqliteStorage(":memory:");
    await runMigrations(store, MIGRATIONS);
  });

  afterEach(async () => {
    await store.close();
  });

  it("persists a Plan-owned conversation independently from ordinary Chat", async () => {
    const repository = createPlanConversationRepository(store);
    await repository.saveConversation(conversation());
    await expect(repository.readConversation(CONVERSATION_ID)).resolves.toEqual(conversation());
    await expect(repository.readLatestOpenConversation()).resolves.toEqual(conversation());
    await expect(repository.readTurns(CONVERSATION_ID)).resolves.toEqual([]);
    await expect(repository.readSourceRequests(CONVERSATION_ID)).resolves.toEqual([]);
    await expect(
      store.get("SELECT name FROM sqlite_master WHERE type='table' AND name='messages'"),
    ).resolves.toBeUndefined();
  });

  it("persists validated Race Course choices on the conversation and Draft revision", async () => {
    const plans = createPlanRepository(store);
    const repository = createPlanConversationRepository(store);
    const course = raceCourseJson();
    await plans.replace(plan(), []);
    const attached = conversation({
      planId: PLAN_ID,
      courseChoiceStatus: "attached",
      raceCourseJson: course,
    });
    await repository.saveConversation(attached);
    await repository.saveDraftRevision(revision({ status: "ready", raceCourseJson: course }));
    await expect(repository.readConversation(CONVERSATION_ID)).resolves.toEqual(attached);
    await expect(repository.readLatestDraftRevision(CONVERSATION_ID)).resolves.toMatchObject({
      raceCourseJson: course,
    });
    await expect(
      repository.saveConversation(
        conversation({
          courseChoiceStatus: "attached",
          raceCourseJson: null,
        }),
      ),
    ).rejects.toEqual(new PlanConversationValidationError("invalid-race-course"));
    await expect(
      repository.saveDraftRevision(
        revision({
          id: SECOND_REVISION_ID,
          revision: 2,
          parentRevisionId: REVISION_ID,
          raceCourseJson: '{"invalid":true}',
        }),
      ),
    ).rejects.toEqual(new PlanConversationValidationError("invalid-draft-revision"));
  });

  it("appends ordered turns idempotently and rejects gaps or changed retries", async () => {
    const repository = createPlanConversationRepository(store);
    await repository.saveConversation(conversation());
    await expect(repository.appendTurn(turn())).resolves.toEqual(turn());
    await expect(repository.appendTurn(turn())).resolves.toEqual(turn());
    await expect(repository.appendTurn(turn({ coachText: "Changed" }))).rejects.toEqual(
      new PlanConversationValidationError("turn-conflict"),
    );
    await expect(
      repository.appendTurn(
        turn({
          id: `${"0".repeat(25)}8`,
          sequence: 3,
        }),
      ),
    ).rejects.toEqual(new PlanConversationValidationError("turn-conflict"));
    const second = turn({
      id: `${"0".repeat(25)}8`,
      sequence: 2,
      athleteText: "Four days.",
      coachText: "I have enough information.",
      completedAtMs: 14,
      hlcPhysicalMs: 14,
    });
    await repository.appendTurn(second);
    await expect(repository.readTurns(CONVERSATION_ID)).resolves.toEqual([turn(), second]);
  });

  it("updates one Draft revision and extends a linear revision chain", async () => {
    const plans = createPlanRepository(store);
    const repository = createPlanConversationRepository(store);
    await plans.replace(plan(), []);
    await repository.saveConversation(conversation({ planId: PLAN_ID }));
    await repository.saveDraftRevision(revision());
    const ready = revision({
      status: "ready",
      snapshotJson: '{"completeWeeks":12}',
      updatedAtMs: 15,
      hlcPhysicalMs: 15,
    });
    await repository.saveDraftRevision(ready);
    const second = revision({
      id: SECOND_REVISION_ID,
      revision: 2,
      parentRevisionId: REVISION_ID,
      status: "ready",
      snapshotJson: '{"completeWeeks":12,"change":"Friday shorter"}',
      createdAtMs: 16,
      updatedAtMs: 16,
      hlcPhysicalMs: 16,
    });
    await repository.saveDraftRevision(second);
    await expect(repository.readDraftRevisions(CONVERSATION_ID)).resolves.toEqual([ready, second]);
    await expect(repository.readLatestDraftRevision(CONVERSATION_ID)).resolves.toEqual(second);
    await expect(
      repository.saveDraftRevision(
        revision({
          id: `${"0".repeat(25)}9`,
          revision: 2,
          parentRevisionId: REVISION_ID,
        }),
      ),
    ).rejects.toEqual(new PlanConversationValidationError("draft-lineage-conflict"));
  });

  it("rejects a Draft parent from another Plan at the SQLite boundary", async () => {
    const plans = createPlanRepository(store);
    const repository = createPlanConversationRepository(store);
    await plans.replace(plan(), []);
    await plans.replace(plan({ id: SECOND_PLAN_ID, name: "Second Plan" }), []);
    await repository.saveConversation(conversation({ planId: PLAN_ID }));
    await repository.saveConversation(
      conversation({
        id: SECOND_CONVERSATION_ID,
        planId: SECOND_PLAN_ID,
      }),
    );
    await repository.saveDraftRevision(revision());
    await expect(
      store.run(
        `INSERT INTO plan_draft_revision (
  id, conversation_id, plan_id, revision, parent_revision_id, parent_revision, status,
  snapshot_json, created_at_ms, updated_at_ms, device_id, hlc_physical_ms, hlc_counter
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          `${"0".repeat(25)}C`,
          SECOND_CONVERSATION_ID,
          SECOND_PLAN_ID,
      2,
      REVISION_ID,
      1,
      "ready",
      '{"completeWeeks":12}',
      17,
      17,
          "device-1",
          17,
          0,
        ],
      ),
    ).rejects.toThrow();
  });

  it("preserves the conversation and source link when its Draft is discarded", async () => {
    const plans = createPlanRepository(store);
    const repository = createPlanConversationRepository(store);
    await plans.replace(plan(), []);
    await repository.saveConversation(conversation({ planId: PLAN_ID }));
    await repository.appendTurn(turn());
    await repository.saveDraftRevision(revision());
    await repository.saveDraftRevision(
      revision({
        id: SECOND_REVISION_ID,
        revision: 2,
        parentRevisionId: REVISION_ID,
        createdAtMs: 14,
        updatedAtMs: 14,
        hlcPhysicalMs: 14,
      }),
    );
    await repository.createOrGetSourceRequest(sourceRequest());

    await plans.delete(PLAN_ID);

    await expect(repository.readConversation(CONVERSATION_ID)).resolves.toEqual(
      conversation({ planId: null }),
    );
    await expect(repository.readTurns(CONVERSATION_ID)).resolves.toEqual([turn()]);
    await expect(repository.readDraftRevisions(CONVERSATION_ID)).resolves.toEqual([]);
    await expect(repository.readSourceRequests(CONVERSATION_ID)).resolves.toEqual([
      sourceRequest(),
    ]);
  });

  it("stores the exact source Conversation separately from the request identity", async () => {
    const repository = createPlanConversationRepository(store);
    await repository.saveConversation(conversation());
    await expect(repository.createOrGetSourceRequest(sourceRequest())).resolves.toEqual(
      sourceRequest(),
    );
    await expect(repository.createOrGetSourceRequest(sourceRequest())).resolves.toEqual(
      sourceRequest(),
    );
    await expect(
      repository.createOrGetSourceRequest(sourceRequest({ sourceChatId: "other" })),
    ).rejects.toEqual(new PlanConversationValidationError("source-request-conflict"));
    await expect(repository.readSourceRequest(REQUEST_ID)).resolves.toEqual(sourceRequest());
  });

  it("keeps a replacement conversation distinct while the old Plan stays active", async () => {
    const plans = createPlanRepository(store);
    const repository = createPlanConversationRepository(store);
    const active = plan({ id: REPLACED_PLAN_ID, status: "active" });
    await plans.replace(active, []);
    const replacement = conversation({ replacesPlanId: REPLACED_PLAN_ID });
    await repository.saveConversation(replacement);
    await expect(repository.readLatestOpenReplacement(REPLACED_PLAN_ID)).resolves.toEqual(
      replacement,
    );
    await expect(plans.read(REPLACED_PLAN_ID)).resolves.toEqual(active);
  });

  it("makes ended conversations read-only and prevents reopening", async () => {
    const repository = createPlanConversationRepository(store);
    await repository.saveConversation(conversation());
    const ended = conversation({
      status: "ended",
      endedAtMs: 20,
      updatedAtMs: 20,
      hlcPhysicalMs: 20,
    });
    await repository.saveConversation(ended);
    await expect(repository.appendTurn(turn())).rejects.toEqual(
      new PlanConversationValidationError("conversation-ended"),
    );
    await expect(repository.createOrGetSourceRequest(sourceRequest())).rejects.toEqual(
      new PlanConversationValidationError("conversation-ended"),
    );
    await expect(
      repository.saveConversation(conversation({ updatedAtMs: 21, hlcPhysicalMs: 21 })),
    ).rejects.toEqual(new PlanConversationValidationError("conversation-conflict"));
    await expect(repository.saveConversation(ended)).resolves.toBeUndefined();
    await expect(
      repository.saveConversation({
        ...ended,
        endedAtMs: 21,
        updatedAtMs: 21,
        hlcPhysicalMs: 21,
      }),
    ).rejects.toEqual(new PlanConversationValidationError("conversation-conflict"));
    await expect(repository.readConversation(CONVERSATION_ID)).resolves.toEqual(ended);
  });
});

describe("Plan conversation relaunch", () => {
  it("restores the dedicated conversation, turns, and source request from SQLite", async () => {
    const root = mkdtempSync(join(tmpdir(), "plan-conversation-"));
    const path = join(root, "store.db");
    try {
      const writer = openSqliteStorage(path);
      await runMigrations(writer, MIGRATIONS);
      const repository = createPlanConversationRepository(writer);
      await repository.saveConversation(conversation());
      await repository.appendTurn(turn());
      const unarchivedSource = sourceRequest({ sourceBoundaryRef: null });
      await repository.createOrGetSourceRequest(unarchivedSource);
      const ended = conversation({
        status: "ended",
        endedAtMs: 20,
        updatedAtMs: 20,
        hlcPhysicalMs: 20,
      });
      await repository.saveConversation(ended);
      await writer.close();

      const reader = openSqliteStorage(path);
      await runMigrations(reader, MIGRATIONS);
      const restored = createPlanConversationRepository(reader);
      await expect(restored.readConversation(CONVERSATION_ID)).resolves.toEqual(ended);
      await expect(restored.readTurns(CONVERSATION_ID)).resolves.toEqual([turn()]);
      await expect(restored.readSourceRequests(CONVERSATION_ID)).resolves.toEqual([
        unarchivedSource,
      ]);
      const archivedSource = sourceRequest({
        sourceBoundaryRef: "archive-boundary",
        updatedAtMs: 21,
        hlcPhysicalMs: 21,
      });
      await expect(restored.bindSourceBoundary(archivedSource)).resolves.toEqual(archivedSource);
      await expect(restored.bindSourceBoundary(archivedSource)).resolves.toEqual(archivedSource);
      await expect(restored.readSourceRequest(REQUEST_ID)).resolves.toEqual(archivedSource);
      await reader.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
