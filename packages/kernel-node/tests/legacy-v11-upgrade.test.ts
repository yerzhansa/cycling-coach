import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { engineConfigFromConfig, type Config } from "@enduragent/core";
import {
  createLegacyWriterFence,
  createPlanCreationRepository,
  createPlanRepository,
} from "@enduragent/kernel/planning";
import { runMigrations, type MigratorStore, type SqlStore } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { createLocalCoachComposition } from "../../coach/src/composition.js";
import { createPlanCreationOperations } from "../../coach/src/plan-creation-operations.js";
import { createAuthoredIdentity, type AthleteHome } from "../src/home/index.js";
import { inertWriterProtocolListener } from "../src/lock/index.js";
import { LEGACY_PLAN_IMPORT_MARKER, readLegacyCurrentPlanSummary } from "../src/planning/index.js";
import {
  dumpLegacyV11Tables,
  legacyCurrentPlanJson,
  legacyV11Store,
} from "./helpers/legacy-v11-store.js";

describe("legacy v11 store upgrade and startup import", () => {
  let root: string;
  let home: AthleteHome;
  let store: SqlStore & MigratorStore;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "legacy-v11-upgrade-"));
    home = {
      root,
      storeDir: join(root, "store"),
      archiveDir: join(root, "archive"),
      configDir: join(root, "config"),
    };
    await Promise.all([
      mkdir(join(root, "plans"), { recursive: true }),
      mkdir(home.archiveDir, { recursive: true }),
      mkdir(home.configDir, { recursive: true }),
    ]);
    store = await legacyV11Store(home.storeDir);
  });

  afterEach(async () => {
    await store.close();
    rmSync(root, { recursive: true, force: true });
  });

  async function startCompositionUntilReferenceBootstrap() {
    const config: Config = {
      dataSource: "store",
      llm: { provider: "anthropic", model: "synthetic", apiKey: "" },
      intervals: { apiKey: "", athleteId: "synthetic" },
      telegram: { botToken: "" },
      session: {
        historyTokenBudgetRatio: 0.3,
        idleMinutes: 0,
        dailyResetHour: 4,
        resetArchiveRetentionDays: 0,
        timezone: "UTC",
      },
      contextWindowTokens: 1000,
      dataDir: home.root,
    };
    const bootstrapReached = new Error("Reference bootstrap reached");
    const bootstrap = vi.fn(async () => {
      throw bootstrapReached;
    });
    await expect(
      createLocalCoachComposition(
        {
          env: { ENDURAGENT_HOME: home.root },
          home,
          context: { home, store, listener: inertWriterProtocolListener },
          config,
          engineConfig: engineConfigFromConfig(config),
        },
        {
          bootstrap,
          now: () => Date.UTC(1998, 6, 7, 12),
        },
      ),
    ).rejects.toBe(bootstrapReached);
    expect(bootstrap).toHaveBeenCalledOnce();
  }

  async function tableNames() {
    const rows = await store.all(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*' ORDER BY name",
    );
    return rows.map((row) => {
      if (typeof row.name !== "string") throw new Error("Expected a table name");
      return row.name;
    });
  }

  async function rowCounts() {
    const counts: Record<string, number> = {};
    for (const name of await tableNames()) {
      const row = await store.get(`SELECT COUNT(*) AS count FROM "${name.replaceAll('"', '""')}"`);
      if (typeof row?.count !== "number") throw new Error("Expected a row count");
      counts[name] = row.count;
    }
    return counts;
  }

  async function logicalDump() {
    const tables: Record<string, Awaited<ReturnType<SqlStore["all"]>>> = {};
    const withoutRowid = new Set(
      (await store.all("SELECT name FROM pragma_table_list WHERE schema = 'main' AND wr = 1")).map(
        (row) => row.name,
      ),
    );
    for (const name of await tableNames()) {
      let orderBy = "rowid";
      if (withoutRowid.has(name)) {
        const primaryKey = await store.all(
          "SELECT name FROM pragma_table_info(?) WHERE pk > 0 ORDER BY pk",
          [name],
        );
        orderBy = primaryKey
          .map((column) => {
            if (typeof column.name !== "string") throw new Error("Expected a primary key column");
            return `"${column.name.replaceAll('"', '""')}"`;
          })
          .join(", ");
      }
      tables[name] = await store.all(
        `SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY ${orderBy}`,
      );
    }
    return tables;
  }

  async function expectMarker() {
    await expect(readFile(join(home.configDir, LEGACY_PLAN_IMPORT_MARKER), "utf8")).resolves.toBe(
      "completed\n",
    );
  }

  it("upgrades v11 without changing seeded rows and creates empty tables", async () => {
    expect(await store.getUserVersion()).toBe(11);
    const before = await dumpLegacyV11Tables(store);
    for (const rows of Object.values(before)) expect(rows).toHaveLength(1);
    const previousTables = new Set(await tableNames());

    const result = await runMigrations(store, MIGRATIONS);

    expect(result.applied).toEqual([
      12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31,
    ]);
    expect(await dumpLegacyV11Tables(store)).toEqual(before);
    const newTables = (await tableNames()).filter((name) => !previousTables.has(name));
    expect(newTables).toEqual([
      "athlete_preference",
      "chat_attachment",
      "chat_attachment_draft",
      "chat_attachment_draft_ref",
      "chat_attachment_object",
      "chat_message_attachment",
      "chat_plan_outbox",
      "plan",
      "plan_adaptation_ledger",
      "plan_change",
      "plan_conversation",
      "plan_conversation_turn",
      "plan_creation",
      "plan_creation_answer",
      "plan_creation_draft_revision",
      "plan_draft_build_checkpoint",
      "plan_draft_revision",
      "plan_intake",
      "plan_proposal",
      "plan_proposal_premise",
      "plan_race_outcome",
      "plan_reconciliation_item",
      "plan_reconciliation_job",
      "plan_replacement",
      "plan_revision",
      "plan_settings",
      "plan_source_request",
      "plan_weekly_review",
      "plan_workout",
      "plan_workout_drift",
      "plan_workout_match",
      "planning_command",
      "planning_plan",
      "planning_request",
      "planning_request_terminal_result",
      "planning_request_tombstone",
      "training_history_backfill_checkpoint",
      "training_history_coverage_commit",
      "training_restriction",
    ]);
    const counts = await rowCounts();
    for (const table of newTables) expect(counts[table], table).toBe(0);
    expect(await store.get("PRAGMA user_version")).toEqual({ user_version: 31 });
  });

  it("writes the startup marker without a Plan when the legacy JSON is absent", async () => {
    await runMigrations(store, MIGRATIONS);

    await startCompositionUntilReferenceBootstrap();

    expect(await createPlanRepository(store).count()).toBe(0);
    await expectMarker();
  });

  it.each(["draft", "active", "with-workouts"] as const)(
    "imports %s once, preserves its source and workout ids, and lists it as read-only legacy history",
    async (variant) => {
      await runMigrations(store, MIGRATIONS);
      const source = legacyCurrentPlanJson(variant);
      const sourcePath = join(root, "plans", "current-plan.json");
      const sourceBytes = Buffer.from(JSON.stringify(source, null, 2));
      await writeFile(sourcePath, sourceBytes);
      const sourceStat = await stat(sourcePath);

      await startCompositionUntilReferenceBootstrap();

      const counts = await rowCounts();
      expect(counts).toMatchObject({
        plan: 1,
        plan_workout: source.workouts.length,
        plan_settings: 1,
        planning_plan: 0,
        plan_revision: 0,
        plan_reconciliation_job: 0,
      });
      const plan = await store.get("SELECT * FROM plan");
      expect(plan).toMatchObject({
        id: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{26}$/),
        origin_id: source.id,
        name: source.name,
        primary_goal: source.primaryGoal,
        start_date_key: Number(source.startDate.replaceAll("-", "")),
        target_date_key: Number(source.targetDate.slice(0, 10).replaceAll("-", "")),
        created_at_ms: Date.parse(source.createdAt),
        updated_at_ms: Date.parse(source.updatedAt),
        kind: "short_race_preparation",
        week_start_day: 1,
        total_weeks: source.totalWeeks,
        status: source.status,
      });
      if (typeof plan?.structure_json !== "string") throw new Error("Expected Plan structure JSON");
      expect(JSON.parse(plan.structure_json)).toEqual(source);
      expect(await store.all("SELECT * FROM plan_settings")).toEqual([
        {
          plan_id: plan.id,
          auto_apply: 0,
          weekly_review: 1,
          updated_at_ms: plan.updated_at_ms,
          device_id: plan.device_id,
          hlc_physical_ms: plan.hlc_physical_ms,
          hlc_counter: plan.hlc_counter,
        },
      ]);
      expect(await readFile(sourcePath)).toEqual(sourceBytes);
      expect((await stat(sourcePath)).mtimeMs).toBe(sourceStat.mtimeMs);
      await expectMarker();
      expect(
        await store.all(
          "SELECT id, plan_id, date_key, sport, name, duration_s, origin, structure_json FROM plan_workout ORDER BY date_key",
        ),
      ).toEqual(
        source.workouts
          .map((workout) => ({
            id: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{26}$/),
            plan_id: plan.id,
            date_key: workout.dateKey ?? Number(workout.date.replaceAll("-", "")),
            sport: workout.sport,
            name: workout.name,
            duration_s: workout.durationS ?? workout.totalDuration,
            origin: workout.origin,
            structure_json: JSON.stringify(workout),
          }))
          .sort((left, right) => left.date_key - right.date_key),
      );
      const beforeSecondLaunch = await logicalDump();

      await startCompositionUntilReferenceBootstrap();

      expect(await logicalDump()).toEqual(beforeSecondLaunch);
      expect(await readFile(sourcePath)).toEqual(sourceBytes);
      expect((await stat(sourcePath)).mtimeMs).toBe(sourceStat.mtimeMs);
      await expectMarker();

      const operations = createPlanCreationOperations({
        legacyPlan: () => readLegacyCurrentPlanSummary({ home, logger: { warn: vi.fn() } }),
        store,
        repository: createPlanCreationRepository(store),
        identity: createAuthoredIdentity(home.configDir, { now: () => Date.UTC(1998, 6, 7, 12) }),
        crypto: globalThis.crypto,
        eventCandidates: { read: async () => [] },
        today: () => "1998-07-07",
        now: () => Date.UTC(1998, 6, 7, 12),
      });
      const library = await operations["plan.list"]({});
      expect(library.legacy).toEqual({
        name: source.name,
        goal: source.primaryGoal,
        weeks: 8,
        sourceStatus: source.status,
        createdAt: "1998-07-04",
        targetDate: "1998-08-30",
        readOnly: true,
        source: "current-plan.json",
      });
      expect(library).toMatchObject({
        active: null,
        closed: [],
        creation: null,
      });
    },
  );

  it("imports on the next launch once the creation fence lifts", async () => {
    await runMigrations(store, MIGRATIONS);
    await writeFile(
      join(root, "plans", "current-plan.json"),
      JSON.stringify(legacyCurrentPlanJson("with-workouts")),
    );
    const repository = createPlanCreationRepository(store);
    const command = {
      commandId: "start-creation",
      requestDigest: "a".repeat(64),
      nowMs: Date.UTC(1998, 6, 7, 12),
      deviceId: "synthetic-device",
      hlcPhysicalMs: Date.UTC(1998, 6, 7, 12),
      hlcCounter: 0,
    };
    const started = await repository.start({
      creationId: "00000000000000000000000001",
      seed: { schemaVersion: 1, eventCandidates: [] },
      command,
    });
    expect(started.outcome).toBe("created");
    const fence = createLegacyWriterFence(store);
    expect(await fence.fenced()).toBe(true);

    await startCompositionUntilReferenceBootstrap();

    expect(await createPlanRepository(store).count()).toBe(0);
    await expect(readFile(join(home.configDir, LEGACY_PLAN_IMPORT_MARKER))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      repository.discard({
        creationId: started.snapshot.id,
        expectedVersion: started.snapshot.version,
        command: {
          ...command,
          commandId: "discard-creation",
          requestDigest: "b".repeat(64),
          hlcCounter: 1,
        },
      }),
    ).resolves.toEqual({ outcome: "discarded" });
    expect(await fence.fenced()).toBe(false);

    await startCompositionUntilReferenceBootstrap();

    expect(await createPlanRepository(store).count()).toBe(1);
    expect(await store.get("SELECT COUNT(*) AS count FROM plan_workout")).toEqual({ count: 2 });
    await expectMarker();
  });
});
