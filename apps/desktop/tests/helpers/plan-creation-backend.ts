import {
  PlanCreationActivateRpcParamsSchema,
  PlanCreationPreviewRpcParamsSchema,
  type CoachEngine,
  type PlanningOperations,
  type PlanCreationCardModel,
} from "@enduragent/coach-contract";
import {
  createPlanCreationRepository,
  type PlanCreationRepository,
} from "@enduragent/kernel/planning";
import { runMigrations, type MigratorStore, type SqlStore } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { inertWriterProtocolListener } from "@enduragent/kernel-node/lock";
import { createPlanningOperations } from "../../../../packages/coach/src/planning-operations.js";
import { openSqliteStorage } from "@enduragent/kernel-node/sqlite";
import {
  createPlanCreationOperations,
  type PlanCreationHost,
} from "../../../../packages/coach/src/plan-creation-operations.js";
import type { DesktopFixtureScript } from "./desktop-fixture.js";
import { createPlanQaFixtureScript } from "./plan-qa-live.js";
import {
  createPlanInspectionFixtureScript,
  PLAN_INSPECTION_TURNS,
} from "./plan-inspection-live.js";

const emptyAttachmentComposer = {
  schemaVersion: 1,
  capabilities: {
    schemaVersion: 1,
    active: { provider: "test", model: "text-only", transport: "test" },
    documents: { enabled: true, extensions: ["pdf", "txt", "csv", "docx"] },
    completedActivities: { enabled: true, extensions: ["fit", "tcx", "gpx"] },
    plannedWorkouts: { enabled: true, extensions: ["zwo", "erg", "mrc"] },
    images: {
      enabled: false,
      mediaTypes: [],
      reason: "model_incompatible",
      source: "maintained_catalogue",
      checkedAt: "1998-09-02T00:00:00.000Z",
    },
  },
  draft: null,
} as const;

interface ScriptRequest {
  readonly method: string;
  readonly params: unknown;
}

interface QueuedMessage {
  readonly queuedMessageId: string;
  readonly messageId: string;
  readonly submissionId: string;
  readonly attachmentIds: readonly string[];
  readonly text: string;
  readonly kind: "ordinary" | "slash-command";
  readonly position: number;
  readonly restored: false;
}

interface TranscriptTurn {
  readonly turnId: string;
  readonly completedAt: string;
  readonly athleteText: string;
  readonly coachText: string;
}

const ordinaryCoachReply = "Keep the effort conversational and finish feeling fresh.";
const completedAt = "1998-09-02T00:00:00.000Z";
const fixtureId = (value: string) => `${"0".repeat(26 - value.length)}${value}`;
const activePlanId = fixtureId("A");
const closedPlanId = fixtureId("B");
const pastChats = [
  {
    boundaryRef: "a".repeat(64),
    boundaryAt: "1998-08-01T00:00:00.000Z",
    reason: "explicit-reset" as const,
    turnCount: 2,
  },
];

export interface StoredPlanCreationAnswerRow {
  readonly sequence: number;
  readonly creation_version: number;
  readonly answer_key: string;
  readonly scope: string;
  readonly value_json: string;
}

const unavailableEngineOperation = async (): Promise<never> => {
  throw new TypeError("Plan inspection does not run Coach operations");
};
const inspectionEngine: CoachEngine = {
  chat: unavailableEngineOperation,
  getCoachDecision: unavailableEngineOperation,
  answerCoachDecision: unavailableEngineOperation,
  skipCoachDecision: unavailableEngineOperation,
  resumeCoachDecision: unavailableEngineOperation,
  resetSession: unavailableEngineOperation,
  hasSession: unavailableEngineOperation,
  getAthleteState: unavailableEngineOperation,
};

const response = (value: unknown): readonly string[] => [JSON.stringify(value)];

export class PlanCreationBackend {
  readonly script: DesktopFixtureScript;
  readonly creationRequests: ScriptRequest[] = [];
  private store: (SqlStore & MigratorStore) | undefined;
  private repository: PlanCreationRepository | undefined;
  private host: PlanCreationHost | undefined;
  private planning: PlanningOperations | undefined;
  planStateReadFails = false;
  private sequence = 0;
  private instant = 883_612_800_000;
  private queueRevision = 0;
  private queue: QueuedMessage[] = [];
  private transcript: TranscriptTurn[] = [];

  constructor(
    private readonly databasePath: string,
    coexistence = false,
    readStoredPlans = false,
  ) {
    const base = coexistence ? createPlanInspectionFixtureScript() : createPlanQaFixtureScript();
    this.script = {
      onRequest: async (value) => {
        const request = value as ScriptRequest;
        if (request.method.startsWith("plan_creation.")) this.creationRequests.push(request);
        if (coexistence && request.method === "listArchivedConversations") {
          return response({
            schemaVersion: 1,
            conversations: [
              {
                boundaryRef: "b".repeat(64),
                boundaryAt: "1998-08-25T08:00:00.000Z",
                reason: "explicit-reset",
                turnCount: 2,
              },
            ],
            truncated: false,
          });
        }
        if (coexistence && request.method === "getArchivedTranscriptPage") {
          return response({
            schemaVersion: 1,
            status: "page",
            turns: PLAN_INSPECTION_TURNS,
            nextCursor: null,
          });
        }
        if (coexistence && request.method === "getRuntimeConfig") {
          const frames = await base.onRequest(value);
          const config = JSON.parse(frames[0] ?? "null");
          return response({
            ...config,
            intervals: { ...config.intervals, credential_configured: false },
          });
        }
        if (
          request.method === "getChatAttachmentComposer" ||
          (!coexistence && request.method === "saveChatAttachmentDraftText") ||
          request.method === "removeChatAttachment" ||
          request.method === "retryChatAttachment" ||
          request.method === "selectChatAttachmentWorkout" ||
          request.method === "clearChatAttachmentDraft"
        ) {
          return response(emptyAttachmentComposer);
        }
        if (!coexistence && request.method === "getChatQueue")
          return response(this.queueSnapshot());
        if (!coexistence && request.method === "enqueueChatMessage")
          return response(this.enqueue(request.params));
        if (!coexistence && request.method === "resumeChatQueue") return this.runScriptedCoach();
        if (!coexistence && request.method === "getTranscriptPage") {
          return response({
            schemaVersion: 1,
            status: "page",
            turns: this.transcript,
            nextCursor: null,
          });
        }
        if (request.method === "listArchivedConversations") {
          return response({ schemaVersion: 1, conversations: pastChats, truncated: false });
        }
        if (request.method === "resumePlanningRequests") return response({ deliveries: [] });
        if (request.method === "listPlanningRequests") {
          return response({ deliveries: [], planCreation: await this.requireHost().readCard() });
        }
        if (
          this.planStateReadFails &&
          (request.method === "getPlanState" || request.method === "getPlanningReadModel")
        ) {
          return response({
            status: "failed",
            error: {
              code: "unavailable",
              message: "Activation could not be saved locally. Your previous Plan is unchanged.",
              retryable: true,
            },
          });
        }
        if (readStoredPlans && request.method === "getPlanState") {
          return response(await this.planState());
        }
        if (request.method === "plan_creation.activate") {
          return response(
            await this.requireHost()["plan_creation.activate"](
              PlanCreationActivateRpcParamsSchema.parse(request.params),
            ),
          );
        }
        if (request.method === "plan_creation.start") {
          return response(
            await this.requireHost()["plan_creation.start"](
              request.params as Parameters<PlanCreationHost["plan_creation.start"]>[0],
            ),
          );
        }
        if (request.method === "plan_creation.answer") {
          return response(
            await this.requireHost()["plan_creation.answer"](
              request.params as Parameters<PlanCreationHost["plan_creation.answer"]>[0],
            ),
          );
        }
        if (request.method === "plan_creation.preview") {
          return response(
            await this.requireHost()["plan_creation.preview"](
              PlanCreationPreviewRpcParamsSchema.parse(request.params),
            ),
          );
        }
        if (request.method === "plan_creation.discard") {
          return response(
            await this.requireHost()["plan_creation.discard"](
              request.params as Parameters<PlanCreationHost["plan_creation.discard"]>[0],
            ),
          );
        }
        return base.onRequest(value);
      },
    };
  }

  async open(): Promise<void> {
    this.store = openSqliteStorage(this.databasePath);
    await runMigrations(this.store, MIGRATIONS);
    this.repository = createPlanCreationRepository(this.store);
    const identity = {
      deviceId: async () => "fixture-device",
      newUlid: () => `${++this.sequence}`.padStart(26, "0"),
      hlcStamp: () => ({ physicalMs: this.instant++, counter: 0 }),
    };
    this.planning = createPlanningOperations(
      {
        context: {
          store: this.store,
          home: {
            root: "/synthetic/athlete",
            storeDir: "/synthetic/athlete/store",
            archiveDir: "/synthetic/athlete/archive",
            configDir: "/synthetic/athlete/config",
          },
          listener: inertWriterProtocolListener,
        },
        identity,
        engine: inspectionEngine,
      },
      { todayDateKey: () => 19980101 },
    );
    this.host = createPlanCreationOperations({
      repository: this.repository,
      identity,
      crypto: globalThis.crypto,
      eventCandidates: { read: async () => [] },
      today: () => "1998-01-01",
    });
  }

  async reopen(): Promise<void> {
    await this.close();
    await this.open();
  }

  async close(): Promise<void> {
    await this.store?.close();
    this.store = undefined;
    this.repository = undefined;
    this.host = undefined;
    this.planning = undefined;
  }

  async card(): Promise<PlanCreationCardModel | null> {
    return this.requireHost().readCard();
  }

  async planState() {
    if (this.planning?.getPlanState === undefined)
      throw new TypeError("Plan inspection is unavailable");
    return this.planning.getPlanState({});
  }

  async inspectActivation() {
    const store = this.requireStore();
    return {
      plans: await store.all("SELECT * FROM plan ORDER BY id"),
      planningPlans: await store.all("SELECT * FROM planning_plan ORDER BY plan_id"),
      revisions: await store.all("SELECT * FROM plan_revision ORDER BY plan_id,revision_number"),
      creations: await store.all("SELECT * FROM plan_creation ORDER BY id"),
      workouts: await store.all("SELECT * FROM plan_workout ORDER BY id"),
      commands: await store.all(
        "SELECT * FROM planning_command WHERE command_name='plan_creation.activate' ORDER BY created_at_ms,command_id",
      ),
    };
  }

  async setActivationFailure(enabled: boolean): Promise<void> {
    const store = this.requireStore();
    if (enabled) {
      await store.run(`CREATE TRIGGER reject_activation BEFORE INSERT ON planning_command
WHEN NEW.command_name='plan_creation.activate'
BEGIN SELECT RAISE(ABORT, 'Activation could not be saved locally. Your previous Plan is unchanged.'); END`);
    } else {
      await store.run("drop trigger if exists reject_activation");
    }
  }

  async answers(): Promise<readonly StoredPlanCreationAnswerRow[]> {
    return (await this.requireStore().all(
      "SELECT sequence,creation_version,answer_key,scope,value_json FROM plan_creation_answer ORDER BY sequence",
    )) as unknown as readonly StoredPlanCreationAnswerRow[];
  }

  async inspect() {
    const store = this.requireStore();
    return {
      creation: await store.get("SELECT status,version FROM plan_creation"),
      answers: await store.all(
        "SELECT sequence,creation_version,answer_key FROM plan_creation_answer ORDER BY sequence",
      ),
      commands: await store.all(
        "SELECT command_name,status FROM planning_command WHERE command_name IN ('plan_creation.start','plan_creation.answer') ORDER BY created_at_ms,command_id",
      ),
    };
  }

  async inspectDrafts() {
    const store = this.requireStore();
    return {
      creations: await store.all(
        "SELECT id,status,version,current_draft_revision_number FROM plan_creation ORDER BY created_at_ms,id",
      ),
      revisions: await store.all(
        "SELECT * FROM plan_creation_draft_revision ORDER BY creation_id,revision_number",
      ),
      commands: await store.all(
        "SELECT * FROM planning_command WHERE command_name='plan_creation.preview' ORDER BY created_at_ms,command_id",
      ),
    };
  }

  async inspectDiscard() {
    const store = this.requireStore();
    const creations = await store.all(
      "SELECT id,status,version,terminal_at_ms FROM plan_creation ORDER BY created_at_ms,id",
    );
    const answers = await store.all(
      "SELECT id,creation_id,sequence,creation_version,answer_key,value_json FROM plan_creation_answer ORDER BY creation_id,sequence,id",
    );
    return {
      commands: await store.all("SELECT * FROM planning_command ORDER BY command_name,command_id"),
      creations: creations.map((row) => ({
        id: String(row.id),
        status: String(row.status),
        version: Number(row.version),
        terminalAtMs: row.terminal_at_ms === null ? null : Number(row.terminal_at_ms),
      })),
      answers: answers.map((row) => ({
        id: String(row.id),
        creationId: String(row.creation_id),
        sequence: Number(row.sequence),
        creationVersion: Number(row.creation_version),
        answerKey: String(row.answer_key),
        valueJson: String(row.value_json),
      })),
    };
  }

  async seedUnrelatedPlans(): Promise<void> {
    const store = this.requireStore();
    const existing = await store.get("SELECT count(*) count FROM planning_plan");
    if (existing?.count === 2) return;
    if (existing?.count !== 0) throw new TypeError("Unrelated Plan fixture is incomplete");
    await store.run(
      `INSERT INTO plan (
id,origin_id,name,primary_goal,start_date_key,target_date_key,status,kind,total_weeks,
week_start_day,structure_json,created_at_ms,updated_at_ms,device_id,hlc_physical_ms,hlc_counter
) VALUES (?,NULL,?,?,19980803,19981025,'active','full_plan',12,1,'{}',?,?,?,?,0)`,
      [
        activePlanId,
        "Active endurance Plan",
        "Complete an autumn endurance event",
        883_000_000_000,
        883_200_000_000,
        "fixture-device",
        883_200_000_000,
      ],
    );
    await store.run(
      `INSERT INTO planning_plan (
plan_id,status,version,current_revision_number,activated_at_ms,closed_at_ms,close_reason,close_actor,
updated_at_ms,device_id,hlc_physical_ms,hlc_counter
) VALUES (?,'active',1,1,883000000000,NULL,NULL,NULL,883200000000,'fixture-device',883200000000,0)`,
      [activePlanId],
    );
    await store.run(
      `INSERT INTO plan (
id,origin_id,name,primary_goal,start_date_key,target_date_key,status,kind,total_weeks,
week_start_day,structure_json,created_at_ms,updated_at_ms,device_id,hlc_physical_ms,hlc_counter
) VALUES (?,NULL,?,?,19980406,19980628,'ended','full_plan',12,1,'{}',?,?,?,?,0)`,
      [
        closedPlanId,
        "Closed base Plan",
        "Build aerobic durability",
        875_000_000_000,
        882_000_000_000,
        "fixture-device",
        882_000_000_000,
      ],
    );
    await store.run(
      `INSERT INTO planning_plan (
plan_id,status,version,current_revision_number,activated_at_ms,closed_at_ms,close_reason,close_actor,
updated_at_ms,device_id,hlc_physical_ms,hlc_counter
) VALUES (?,'closed',2,1,875000000000,882000000000,'stopped','athlete',882000000000,'fixture-device',882000000000,0)`,
      [closedPlanId],
    );
    await store.run(`INSERT INTO planned_workout (id,date_key,sport,structure_json,provenance,device_id,hlc_physical_ms,hlc_counter)
VALUES ('0000000000000000000000000C',19980714,'cycling','{"durationMinutes":45}','manual','fixture-device',883200000000,0)`);
    await store.run(`INSERT INTO athlete_preference (id,preference_key,value_json,status,version,created_at_ms,updated_at_ms,device_id,hlc_physical_ms,hlc_counter)
VALUES ('0000000000000000000000000D','weekly-hours','8','active',1,883200000000,883200000000,'fixture-device',883200000000,0)`);
    await store.run(`INSERT INTO training_restriction (id,kind,status,version,start_date_key,end_date_key,confirmed_at_ms,created_at_ms,updated_at_ms,device_id,hlc_physical_ms,hlc_counter)
VALUES ('0000000000000000000000000E','no-hard-training','active',1,19980713,19980720,883200000000,883200000000,883200000000,'fixture-device',883200000000,0)`);
  }

  async inspectUnrelated() {
    const store = this.requireStore();
    return {
      plans: await store.all("SELECT * FROM plan ORDER BY id"),
      schedule: await store.all("SELECT * FROM planned_workout ORDER BY id"),
      preferences: await store.all("SELECT * FROM athlete_preference ORDER BY id"),
      restrictions: await store.all("SELECT * FROM training_restriction ORDER BY id"),
      activePlans: await store.all(
        "SELECT * FROM planning_plan WHERE status='active' ORDER BY plan_id",
      ),
      closedPlans: await store.all(
        "SELECT * FROM planning_plan WHERE status='closed' ORDER BY plan_id",
      ),
    };
  }

  private queueSnapshot() {
    return { schemaVersion: 1 as const, revision: this.queueRevision, items: this.queue };
  }

  private enqueue(value: unknown) {
    const params = value as {
      readonly submissionId: string;
      readonly text: string;
      readonly attachmentIds?: readonly string[];
    };
    if (!this.queue.some((item) => item.submissionId === params.submissionId)) {
      this.queueRevision += 1;
      this.queue.push({
        queuedMessageId: `queued-${this.queueRevision}`,
        messageId: `message-${this.queueRevision}`,
        submissionId: params.submissionId,
        attachmentIds: params.attachmentIds ?? [],
        text: params.text,
        kind: params.text.trimStart().startsWith("/") ? "slash-command" : "ordinary",
        position: this.queue.length,
        restored: false,
      });
    }
    return this.queueSnapshot();
  }

  private runScriptedCoach(): readonly string[] {
    const queued = this.queue[0];
    if (queued === undefined || this.queue.length !== 1 || queued.kind !== "ordinary") {
      throw new TypeError("Scripted Coach requires one ordinary queued message");
    }
    const turnId = `ordinary-turn-${this.transcript.length + 1}`;
    this.transcript.push({
      turnId,
      completedAt,
      athleteText: queued.text,
      coachText: ordinaryCoachReply,
    });
    this.queue = [];
    this.queueRevision += 1;
    return [
      JSON.stringify({ type: "turn-start", turnId, chatId: "desktop" }),
      JSON.stringify({ type: "text_delta", turnId, delta: ordinaryCoachReply }),
      JSON.stringify({ type: "final-text", turnId, text: ordinaryCoachReply }),
      JSON.stringify({ snapshot: this.queueSnapshot(), response: { text: ordinaryCoachReply } }),
    ];
  }

  private requireStore(): SqlStore & MigratorStore {
    if (this.store === undefined) throw new TypeError("Plan Creation store is closed");
    return this.store;
  }

  private requireHost(): PlanCreationHost {
    if (this.host === undefined) throw new TypeError("Plan Creation host is closed");
    return this.host;
  }
}
