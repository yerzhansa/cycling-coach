import type { PlanCreationCardModel } from "@enduragent/coach-contract";
import {
  createPlanCreationRepository,
  type PlanCreationRepository,
} from "@enduragent/kernel/planning";
import { runMigrations, type MigratorStore, type SqlStore } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { openSqliteStorage } from "@enduragent/kernel-node/sqlite";
import {
  createPlanCreationOperations,
  type PlanCreationHost,
} from "../../../../packages/coach/src/plan-creation-operations.js";
import type { DesktopFixtureScript } from "./desktop-fixture.js";
import { createPlanQaFixtureScript } from "./plan-qa-live.js";

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

export interface StoredPlanCreationAnswerRow {
  readonly sequence: number;
  readonly creation_version: number;
  readonly answer_key: string;
  readonly scope: string;
  readonly value_json: string;
}

const response = (value: unknown): readonly string[] => [JSON.stringify(value)];

export class PlanCreationBackend {
  readonly script: DesktopFixtureScript;
  private store: (SqlStore & MigratorStore) | undefined;
  private repository: PlanCreationRepository | undefined;
  private host: PlanCreationHost | undefined;
  private sequence = 0;
  private instant = 883_612_800_000;

  constructor(private readonly databasePath: string) {
    const base = createPlanQaFixtureScript();
    this.script = {
      onRequest: async (value) => {
        const request = value as ScriptRequest;
        if (request.method === "getChatAttachmentComposer") {
          return response(emptyAttachmentComposer);
        }
        if (request.method === "resumePlanningRequests") return response({ deliveries: [] });
        if (request.method === "listPlanningRequests") {
          return response({ deliveries: [], planCreation: await this.requireHost().readCard() });
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
        return base.onRequest(value);
      },
    };
  }

  async open(): Promise<void> {
    this.store = openSqliteStorage(this.databasePath);
    await runMigrations(this.store, MIGRATIONS);
    this.repository = createPlanCreationRepository(this.store);
    this.host = createPlanCreationOperations({
      repository: this.repository,
      identity: {
        deviceId: async () => "fixture-device",
        newUlid: () => `${++this.sequence}`.padStart(26, "0"),
        hlcStamp: () => ({ physicalMs: this.instant++, counter: 0 }),
      },
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
  }

  async card(): Promise<PlanCreationCardModel | null> {
    return this.requireHost().readCard();
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

  private requireStore(): SqlStore & MigratorStore {
    if (this.store === undefined) throw new TypeError("Plan Creation store is closed");
    return this.store;
  }

  private requireHost(): PlanCreationHost {
    if (this.host === undefined) throw new TypeError("Plan Creation host is closed");
    return this.host;
  }
}
