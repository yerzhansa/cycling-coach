import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Config, ReferenceRuntime } from "@enduragent/core";
import { runMigrations } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import type { AthleteHome } from "@enduragent/kernel-node/home";
import { openReadonlySqliteStorage, openSqliteStorage } from "@enduragent/kernel-node/sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCoachOperations } from "../src/operations.js";
import type { CoachStoreWriterContext } from "../src/runtime.js";
import { createStoreRuntime, type StoreRuntimeDependencies } from "../src/store-runtime.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const config = (root: string): Config => ({
  dataSource: "store",
  llm: { provider: "openai-codex", model: "gpt-5.4", apiKey: "" },
  intervals: { apiKey: "", athleteId: "" },
  telegram: { botToken: "" },
  session: {
    historyTokenBudgetRatio: 0.3,
    idleMinutes: 0,
    dailyResetHour: 4,
    resetArchiveRetentionDays: 0,
    timezone: "UTC",
  },
  contextWindowTokens: 1_000,
  dataDir: root,
});

async function fixture(dependencies: StoreRuntimeDependencies = {}): Promise<{
  readonly home: AthleteHome;
  readonly context: CoachStoreWriterContext;
  readonly runtime: ReturnType<typeof createStoreRuntime>;
  readonly operations: ReturnType<typeof createCoachOperations>;
}> {
  const root = await mkdtemp(join(await realpath(tmpdir()), "canonical-activity-coaching-"));
  roots.push(root);
  const home: AthleteHome = {
    root,
    storeDir: join(root, "store"),
    archiveDir: join(root, "archive"),
    configDir: join(root, "config"),
  };
  await Promise.all([
    mkdir(home.storeDir, { recursive: true }),
    mkdir(home.archiveDir, { recursive: true }),
    mkdir(home.configDir, { recursive: true }),
  ]);
  const store = openSqliteStorage(join(home.storeDir, "store.db"));
  await runMigrations(store, MIGRATIONS);
  const context: CoachStoreWriterContext = {
    home,
    store,
    listener: {} as CoachStoreWriterContext["listener"],
  };
  const reference = {
    scheduler: { stop: vi.fn() },
    services: {},
    runScheduledOnce: vi.fn(async () => ({
      kind: "ran",
      lastSyncAt: "1998-07-18T12:00:00.000Z",
      refreshed: [],
    })),
  } as unknown as ReferenceRuntime;
  const runtime = createStoreRuntime({
    env: {},
    config: config(root),
    home,
    reference,
    writerContext: context,
    dependencies: {
      now: () => new Date("1998-07-18T12:00:00.000Z"),
      monotonicNow: () => 1,
      ...dependencies,
    },
  });
  const operations = createCoachOperations({
    home,
    context,
    runtime,
    intervalsCredentials: { read: async () => ({ apiKey: "", athleteId: "" }) },
    historyNewestDate: () => "1998-07-18",
    applyRuntimeConfig: async () => {},
  });
  return { home, context, runtime, operations };
}

const importPath = resolve(
  import.meta.dirname,
  "../../kernel-node/tests/fixtures/ingest/triathlon-multisport.fit",
);

async function coachingSnapshot(runtime: ReturnType<typeof createStoreRuntime>) {
  const listed = await runtime.athleteData.listActivities({
    start: "1998-07-01",
    end: "1998-07-31",
  });
  expect(listed.ok).toBe(true);
  const activities = listed.ok ? listed.value : [];
  const cycling = activities.find(
    (activity) => (activity as { sport?: unknown }).sport === "cycling",
  ) as { id: string } | undefined;
  expect(cycling?.id).toMatch(/^[0-9a-f]{64}$/);
  const detail = await runtime.athleteData.getActivity({ id: cycling!.id });
  const streams = await runtime.athleteData.getStreams({
    id: cycling!.id,
    keys: ["time"],
  });
  expect(detail).toMatchObject({ ok: true, value: { id: cycling!.id } });
  expect(streams).toMatchObject({ ok: true, value: { time: expect.any(Array) } });
  return { listed, detail, streams };
}

describe("canonical activity coaching cutover", () => {
  it("reads an import immediately and identically after a credential-free restart", async () => {
    const first = await fixture();
    try {
      await expect(first.operations.importFiles({ paths: [importPath] })).resolves.toMatchObject({
        schemaVersion: 2,
        files: { total: 1, imported: 1, quarantined: 0 },
        publication: { scope: "activities-and-streams", status: "available" },
      });
      const immediate = await coachingSnapshot(first.runtime);
      await first.runtime.close();

      const reference = {
        scheduler: { stop: vi.fn() },
        services: {},
        runScheduledOnce: vi.fn(async () => ({
          kind: "ran",
          lastSyncAt: "1998-07-18T12:00:00.000Z",
          refreshed: [],
        })),
      } as unknown as ReferenceRuntime;
      const reopened = createStoreRuntime({
        env: {},
        config: config(first.home.root),
        home: first.home,
        reference,
        writerContext: first.context,
        dependencies: {
          now: () => new Date("1998-07-18T12:00:00.000Z"),
          monotonicNow: () => 1,
        },
      });
      try {
        expect(await coachingSnapshot(reopened)).toEqual(immediate);
      } finally {
        await reopened.close();
      }
    } finally {
      await first.runtime.close();
      await first.context.store.close();
    }
  });

  it("keeps durable ingestion when publication fails and makes a zero-insert retry available", async () => {
    let attempts = 0;
    const selected = await fixture({
      openReadonlyStore(path) {
        attempts += 1;
        if (attempts <= 2) throw new Error("synthetic read handle failure");
        return openReadonlySqliteStorage(path);
      },
    });
    try {
      await expect(selected.operations.importFiles({ paths: [importPath] })).resolves.toMatchObject(
        {
          schemaVersion: 2,
          changes: { rawFilesInserted: 1 },
          publication: { status: "retryable-failure" },
        },
      );
      await expect(
        selected.context.store.get("SELECT count(*) AS count FROM raw_file"),
      ).resolves.toEqual({ count: 1 });
      await expect(selected.operations.importFiles({ paths: [importPath] })).resolves.toMatchObject(
        {
          schemaVersion: 2,
          changes: { rawFilesInserted: 0 },
          publication: { status: "available" },
        },
      );
      await coachingSnapshot(selected.runtime);
    } finally {
      await selected.runtime.close();
      await selected.context.store.close();
    }
  });
});
