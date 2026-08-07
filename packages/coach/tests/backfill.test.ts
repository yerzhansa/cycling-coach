import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSyncStateRepository,
  dumpStore,
  runMigrations,
  type SourceArtifact,
} from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { createNodeImportRuntime } from "@enduragent/kernel-node/ingest";
import { openSqliteStorage } from "@enduragent/kernel-node/sqlite";
import type { IntervalsIcuSource } from "@enduragent/sync-intervals-icu";
import type { AthleteHome } from "@enduragent/kernel-node/home";
import {
  assertRuntimeAthleteOwner,
  checkIntervalsStoreOwnerAtPath,
  createIntervalsBackfillSource,
  runBackfillPages,
  runIntervalsBackfill,
  runIntervalsBackfillInWriter,
} from "../src/backfill.js";
import { createCoachOperations } from "../src/operations.js";
import type { CoachStoreWriterContext } from "../src/runtime.js";

const complete = JSON.stringify({
  v: 1,
  cycle: 0,
  window_start: "2010-12-05",
  window_end: "2010-12-31",
  last_key: null,
  complete: true,
});
const clock = { now: () => 1_300_000_000_000, monotonicNow: () => 1_000 };

describe("incremental backfill pages", () => {
  type BackfillRequest = Readonly<{
    endpoint: "profile" | "activities";
    url: URL;
  }>;
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  async function fresh() {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "backfill-page-"));
    roots.push(root);
    const store = openSqliteStorage(join(root, "store.db"));
    await runMigrations(store, MIGRATIONS);
    const node = createNodeImportRuntime({ archiveDir: join(root, "archive"), store });
    return { root, store, node };
  }
  async function raw(
    node: ReturnType<typeof createNodeImportRuntime>,
    name = "one.fit",
  ): Promise<Extract<SourceArtifact, { kind: "raw-file" }>> {
    const bytes = new Uint8Array(
      readFileSync("packages/kernel-node/tests/fixtures/ingest/brick-cycling.fit"),
    );
    const archiveInstant = { epochSeconds: 899_585_600 };
    const archive = await node.archive.writeArtifact(bytes, "fit", archiveInstant);
    return {
      kind: "raw-file",
      source: "intervals-icu",
      lane: "bulk-fit",
      externalId: name,
      archiveInstant,
      archive,
      container: null,
      file: { input_path: name, bytes, ext: "fit" },
    } as Extract<SourceArtifact, { kind: "raw-file" }>;
  }
  function source(
    pulls: (watermark: string | null, call: number) => AsyncIterable<SourceArtifact>,
  ): IntervalsIcuSource {
    let call = 0;
    return {
      id: "intervals-icu",
      capabilities: {
        activities: true,
        streams: true,
        rawFiles: true,
        wellness: true,
        plannedWorkoutPush: false,
        backfillDepth: { kind: "full-history" },
      },
      pull(watermark) {
        return pulls(watermark.value, call++);
      },
    } as IntervalsIcuSource;
  }

  function profileFetch(
    account: string,
    requests: BackfillRequest[] = [],
    athleteId = "0",
  ): typeof globalThis.fetch {
    return vi.fn(async (input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const profilePath = `/api/v1/athlete/${encodeURIComponent(athleteId)}`;
      let body: unknown;
      if (url.pathname === profilePath) {
        requests.push({ endpoint: "profile", url });
        body = {
          sportSettings: [
            { id: 1, athlete_id: account, types: ["Ride"], updated: "2010-01-01" },
          ],
        };
      } else if (url.pathname === `${profilePath}/activities`) {
        requests.push({ endpoint: "activities", url });
        body = [];
      } else {
        throw new Error("unexpected request");
      }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
  }

  function unresolvedProfileFetch(requests: BackfillRequest[] = []): typeof globalThis.fetch {
    return vi.fn(async (input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      let body: unknown;
      if (url.pathname === "/api/v1/athlete/0") {
        requests.push({ endpoint: "profile", url });
        body = { sportSettings: [] };
      } else if (url.pathname === "/api/v1/athlete/0/activities") {
        requests.push({ endpoint: "activities", url });
        body = [];
      } else {
        throw new Error("unexpected request");
      }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
  }

  function athleteHome(root: string, storeDir = root): AthleteHome {
    return {
      root,
      storeDir,
      archiveDir: join(root, "archive"),
      configDir: join(root, "config"),
    };
  }

  async function syncInWriter(
    value: Awaited<ReturnType<typeof fresh>>,
    account: string,
    apiKey = "synthetic",
  ) {
    const baseFetch = profileFetch(account);
    const result = await runIntervalsBackfillInWriter({
      home: athleteHome(value.root),
      store: value.store,
      apiKey,
      athleteId: "0",
      historyNewestDate: "1900-12-31",
      clock,
      sleep: async () => {},
      baseFetch,
    });
    return { baseFetch, result };
  }

  async function syncInWriterWithFetch(
    value: Awaited<ReturnType<typeof fresh>>,
    accountKey: string,
    baseFetch: typeof globalThis.fetch,
  ) {
    const result = await runIntervalsBackfillInWriter({
      home: athleteHome(value.root),
      store: value.store,
      apiKey: accountKey,
      athleteId: "0",
      historyNewestDate: "1900-12-31",
      clock,
      sleep: async () => {},
      baseFetch,
    });
    return { baseFetch, result };
  }

  async function storedSyncState(store: Awaited<ReturnType<typeof fresh>>["store"]) {
    return {
      dump: await dumpStore(store),
      owner: await store.all("SELECT * FROM store_owner"),
      watermarks: await store.all("SELECT * FROM source_watermark"),
      operations: await store.all("SELECT * FROM sync_operation"),
    };
  }

  it("commits each page checkpoint atomically and finishes with one terminal no-op", async () => {
    const value = await fresh();
    try {
      const item = await raw(value.node);
      const fake = source((_watermark, call) =>
        (async function* () {
          if (call === 0) yield item;
          yield {
            kind: "checkpoint",
            watermark: { source: "intervals-icu", lane: "bulk-fit", value: complete },
          };
        })(),
      );
      const result = await runBackfillPages({
        store: value.store,
        node: value.node,
        source: fake,
        clock,
      });
      expect(result).toMatchObject({ pages: 2, artifacts: 1 });
      expect(
        await value.store.get(
          "SELECT watermark FROM source_watermark WHERE source='intervals-icu' AND lane='bulk-fit'",
        ),
      ).toEqual({ watermark: complete });
      expect(
        await value.store.all(
          "SELECT artifacts_seen,completion_kind FROM sync_operation ORDER BY operation_id",
        ),
      ).toEqual([
        { artifacts_seen: 1, completion_kind: "applied" },
        { artifacts_seen: 0, completion_kind: "no-op" },
      ]);
      expect(await value.store.get("SELECT count(*) AS n FROM raw_file")).toEqual({ n: 1 });
    } finally {
      await value.store.close();
    }
  });

  it.each([
    [
      "wrong checkpoint",
      () =>
        source(() =>
          (async function* () {
            yield {
              kind: "checkpoint",
              watermark: { source: "file-import", lane: "bulk-fit", value: complete },
            } as SourceArtifact;
          })(),
        ),
    ],
    [
      "multiple checkpoint",
      () =>
        source(() =>
          (async function* () {
            const checkpoint = {
              kind: "checkpoint",
              watermark: { source: "intervals-icu", lane: "bulk-fit", value: complete },
            } as SourceArtifact;
            yield checkpoint;
            yield checkpoint;
          })(),
        ),
    ],
    [
      "nonterminal invalid checkpoint",
      () =>
        source(() =>
          (async function* () {
            yield {
              kind: "checkpoint",
              watermark: { source: "intervals-icu", lane: "bulk-fit", value: "{}" },
            } as SourceArtifact;
          })(),
        ),
    ],
  ])("rejects %s and commits nothing", async (_name, makeSource) => {
    const value = await fresh();
    try {
      await expect(
        runBackfillPages({ store: value.store, node: value.node, source: makeSource(), clock }),
      ).rejects.toThrow();
      expect(await value.store.get("SELECT count(*) AS n FROM sync_operation")).toEqual({ n: 0 });
      expect(await value.store.get("SELECT count(*) AS n FROM raw_file")).toEqual({ n: 0 });
    } finally {
      await value.store.close();
    }
  });

  it("deduplicates an over-yielded immutable artifact within a page", async () => {
    const value = await fresh();
    try {
      const one = await raw(value.node, "one"),
        two = {
          ...one,
          externalId: "two",
          file: { ...one.file, input_path: "two.fit" },
        } as SourceArtifact;
      const fake = source((_watermark, call) =>
        (async function* () {
          if (call === 0) {
            yield one;
            yield two;
          }
          yield {
            kind: "checkpoint",
            watermark: { source: "intervals-icu", lane: "bulk-fit", value: complete },
          };
        })(),
      );
      const result = await runBackfillPages({
        store: value.store,
        node: value.node,
        source: fake,
        clock,
        batchSize: 2,
      });
      expect(result.artifacts).toBe(2);
      expect(await value.store.get("SELECT count(*) AS n FROM raw_file")).toEqual({ n: 1 });
      expect(await value.store.get("SELECT count(*) AS n FROM source_artifact")).toEqual({ n: 2 });
    } finally {
      await value.store.close();
    }
  });

  it("constructs the backfill source with the fixed full-history floor", () => {
    const archive = {
      writeArtifact: async () => {
        throw new Error("unused");
      },
    } as never;
    const created = createIntervalsBackfillSource({
      apiKey: String.fromCharCode(116, 101, 115, 116),
      athleteId: "test-athlete",
      historyNewestDate: "2010-12-31",
      minRequestIntervalMs: 250,
      archive,
      clock,
      sleep: async () => {},
      baseFetch: async () => {
        throw new Error("unused");
      },
    });
    expect(created.id).toBe("intervals-icu");
    expect(created.capabilities.backfillDepth).toEqual({ kind: "full-history" });
  });

  it("issues a request after the UTC date advances within one operations process", async () => {
    const value = await fresh();
    const home: AthleteHome = {
      root: value.root,
      storeDir: join(value.root, "store"),
      archiveDir: join(value.root, "archive"),
      configDir: join(value.root, "config"),
    };
    const context: CoachStoreWriterContext = {
      home,
      store: value.store,
      listener: {} as CoachStoreWriterContext["listener"],
    };
    let now = Date.UTC(1900, 0, 1);
    const requests: BackfillRequest[] = [];
    const baseFetch = profileFetch(
      "synthetic-rollover-account",
      requests,
      "synthetic-athlete",
    );
    const rollingClock = { now: () => now, monotonicNow: () => 1_000 };
    const operations = createCoachOperations(
      {
        home,
        context,
        runtime: {
          async runExclusive(work) {
            return work(new AbortController().signal);
          },
          async runActivityWrite(work) {
            return {
              value: await work(new AbortController().signal),
              activityReadAvailable: true,
            };
          },
          async runWindowAfter(work) {
            await work(new AbortController().signal);
            return {
              published: true,
              legacySucceeded: true,
              counts: {
                storeRequests: 0,
                legacyRequests: 0,
                totalRequests: 0,
                byTag: {
                  "store:activities": 0,
                  "store:wellness": 0,
                  "store:settings": 0,
                  "store:streams": 0,
                  "legacy:reference": 0,
                },
              },
            };
          },
        },
        intervalsCredentials: {
          read: async () => ({ apiKey: String.fromCharCode(116, 101, 115, 116), athleteId: "synthetic-athlete" }),
        },
        historyNewestDate: () => new Date(now).toISOString().slice(0, 10),
        applyRuntimeConfig: async () => {},
      },
      {
        backfill: (options) => runIntervalsBackfillInWriter({
          ...options,
          clock: rollingClock,
          sleep: async () => {},
          baseFetch,
        }),
      },
    );
    try {
      await expect(operations.sync({})).resolves.toMatchObject({ schemaVersion: 1 });
      await expect(createSyncStateRepository(value.store).readWatermark("intervals-icu", "bulk-fit")).resolves.toEqual({
        source: "intervals-icu",
        lane: "bulk-fit",
        value: JSON.stringify({ v: 1, cycle: 0, window_start: "1900-01-01", window_end: "1900-01-01",
          last_key: null, complete: true }),
      });
      const ownerAfterFirstSync = await value.store.all("SELECT * FROM store_owner");
      expect(ownerAfterFirstSync).toHaveLength(1);
      now = Date.UTC(1900, 0, 2);
      await expect(operations.sync({})).resolves.toMatchObject({ schemaVersion: 1 });

      expect(requests.map(({ endpoint }) => endpoint)).toEqual([
        "profile",
        "activities",
        "profile",
        "activities",
      ]);
      const profileRequests = requests.filter(({ endpoint }) => endpoint === "profile");
      const activityRequests = requests.filter(({ endpoint }) => endpoint === "activities");
      expect(profileRequests).toHaveLength(2);
      expect(activityRequests).toHaveLength(2);
      expect([...activityRequests[0]!.url.searchParams]).toEqual([
        ["oldest", "1900-01-01"],
        ["newest", "1900-01-01"],
      ]);
      expect([...activityRequests[1]!.url.searchParams]).toEqual([
        ["oldest", "1900-01-01"],
        ["newest", "1900-01-02"],
      ]);
      expect(await value.store.all("SELECT * FROM store_owner")).toEqual(ownerAfterFirstSync);
      await expect(createSyncStateRepository(value.store).readWatermark("intervals-icu", "bulk-fit")).resolves.toEqual({
        source: "intervals-icu",
        lane: "bulk-fit",
        value: JSON.stringify({ v: 1, cycle: 1, window_start: "1900-01-01", window_end: "1900-01-02",
          last_key: null, complete: true }),
      });
    } finally {
      await value.store.close();
    }
  });

  it("claims the owner when the first sync creates the store and detects a different credential afterward", async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "backfill-first-sync-"));
    roots.push(root);
    const storePath = join(root, "store", "store.db");
    const firstFetch = profileFetch("synthetic-athlete-first");
    expect(existsSync(storePath)).toBe(false);

    await runIntervalsBackfill({
      env: { ENDURAGENT_HOME: root },
      apiKey: "synthetic-first",
      athleteId: "0",
      historyNewestDate: "1900-12-31",
      clock,
      sleep: async () => {},
      baseFetch: firstFetch,
    });

    expect(existsSync(storePath)).toBe(true);
    const store = openSqliteStorage(storePath);
    try {
      expect(await store.get("SELECT count(*) AS count FROM store_owner")).toEqual({ count: 1 });
    } finally {
      await store.close();
    }
    expect(firstFetch).toHaveBeenCalledTimes(2);
    const mismatchFetch = profileFetch("synthetic-athlete-other");
    await expect(
      checkIntervalsStoreOwnerAtPath(storePath, {
        apiKey: "synthetic-other",
        athleteId: "0",
        historyNewestDate: "1900-12-31",
        clock,
        sleep: async () => {},
        baseFetch: mismatchFetch,
      }),
    ).resolves.toBe("mismatch");
    expect(mismatchFetch).toHaveBeenCalledOnce();
  });

  it("claims an ownerless store from the current account before resolving the candidate", async () => {
    const value = await fresh();
    const fingerprint = "a".repeat(64);
    const resolveFingerprint = vi.fn(
      async (options: { readonly apiKey: string; readonly athleteId: string }) => {
        if (options.apiKey === "current-key") {
          expect(await value.store.get("SELECT count(*) AS count FROM store_owner")).toEqual({
            count: 0,
          });
        } else {
          expect(options.apiKey).toBe("candidate-key");
          expect(await value.store.get("SELECT account_fingerprint FROM store_owner")).toEqual({
            account_fingerprint: fingerprint,
          });
        }
        return fingerprint;
      },
    );
    try {
      await assertRuntimeAthleteOwner(
        value.store,
        {
          current: {
            apiKey: "current-key",
            athleteId: "current-athlete",
            historyNewestDate: "1900-12-31",
            clock,
          },
          candidate: {
            apiKey: "candidate-key",
            athleteId: "candidate-athlete",
            historyNewestDate: "1900-12-31",
            clock,
          },
          signal: new AbortController().signal,
        },
        resolveFingerprint,
      );

      expect(resolveFingerprint.mock.calls.map(([options]) => options.athleteId)).toEqual([
        "current-athlete",
        "candidate-athlete",
      ]);
    } finally {
      await value.store.close();
    }
  });

  it("skips current-account lookup when the store already has an owner", async () => {
    const value = await fresh();
    const fingerprint = "a".repeat(64);
    await value.store.run(
      "INSERT INTO store_owner (singleton, account_fingerprint) VALUES (1, ?)",
      [fingerprint],
    );
    const resolveFingerprint = vi.fn(async () => fingerprint);
    try {
      await assertRuntimeAthleteOwner(
        value.store,
        {
          current: {
            apiKey: "",
            athleteId: "0",
            historyNewestDate: "1900-12-31",
            clock,
          },
          candidate: {
            apiKey: "candidate-key",
            athleteId: "0",
            historyNewestDate: "1900-12-31",
            clock,
          },
          signal: new AbortController().signal,
        },
        resolveFingerprint,
      );

      expect(resolveFingerprint).toHaveBeenCalledOnce();
      expect(resolveFingerprint).toHaveBeenCalledWith(
        expect.objectContaining({ apiKey: "candidate-key", athleteId: "0" }),
      );
    } finally {
      await value.store.close();
    }
  });

  it("defers and claims a resolved first credential when no current account exists", async () => {
    const value = await fresh();
    const fingerprint = "a".repeat(64);
    const resolveFingerprint = vi.fn(async () => fingerprint);
    try {
      const pendingClaim = await assertRuntimeAthleteOwner(
        value.store,
        {
          current: {
            apiKey: "",
            athleteId: "0",
            historyNewestDate: "1900-12-31",
            clock,
          },
          candidate: {
            apiKey: "candidate-key",
            athleteId: "0",
            historyNewestDate: "1900-12-31",
            clock,
          },
          signal: new AbortController().signal,
          claimUnownedCandidateWithoutCurrent: true,
        },
        resolveFingerprint,
      );

      expect(resolveFingerprint).toHaveBeenCalledOnce();
      expect(resolveFingerprint).toHaveBeenCalledWith(
        expect.objectContaining({ apiKey: "candidate-key", athleteId: "0" }),
      );
      expect(await value.store.get("SELECT count(*) AS count FROM store_owner")).toEqual({
        count: 0,
      });
      await pendingClaim?.claim();
      expect(await value.store.get("SELECT account_fingerprint FROM store_owner")).toEqual({
        account_fingerprint: fingerprint,
      });
    } finally {
      await value.store.close();
    }
  });

  it.each(["null", "rejection", "abort"] as const)(
    "does not bind a first credential after candidate %s",
    async (failure) => {
      const value = await fresh();
      const controller = new AbortController();
      const resolveFingerprint = vi.fn(async () => {
        if (failure === "null") return null;
        if (failure === "rejection") throw new Error("synthetic candidate lookup failure");
        controller.abort(new Error("synthetic admission close"));
        return "a".repeat(64);
      });
      try {
        await expect(
          assertRuntimeAthleteOwner(
            value.store,
            {
              current: {
                apiKey: "",
                athleteId: "0",
                historyNewestDate: "1900-12-31",
                clock,
              },
              candidate: {
                apiKey: "candidate-key",
                athleteId: "0",
                historyNewestDate: "1900-12-31",
                clock,
              },
              signal: controller.signal,
              claimUnownedCandidateWithoutCurrent: true,
            },
            resolveFingerprint,
          ),
        ).rejects.toMatchObject({ reason: "candidate-unresolved" });
        expect(await value.store.get("SELECT count(*) AS count FROM store_owner")).toEqual({
          count: 0,
        });
      } finally {
        await value.store.close();
      }
    },
  );

  it("refuses an unowned athlete change without a current credential", async () => {
    const value = await fresh();
    const resolveFingerprint = vi.fn(async () => "a".repeat(64));
    try {
      await expect(
        assertRuntimeAthleteOwner(
          value.store,
          {
            current: {
              apiKey: "",
              athleteId: "0",
              historyNewestDate: "1900-12-31",
              clock,
            },
            candidate: {
              apiKey: "candidate-key",
              athleteId: "candidate-athlete",
              historyNewestDate: "1900-12-31",
              clock,
            },
            signal: new AbortController().signal,
          },
          resolveFingerprint,
        ),
      ).rejects.toMatchObject({ reason: "current-credential-missing" });
      expect(resolveFingerprint).not.toHaveBeenCalled();
      expect(await value.store.get("SELECT count(*) AS count FROM store_owner")).toEqual({
        count: 0,
      });
    } finally {
      await value.store.close();
    }
  });

  it("aborts a bounded owner lookup before claiming the store", async () => {
    const value = await fresh();
    const resolveFingerprint = vi.fn(
      async (options: { readonly signal?: AbortSignal }): Promise<string> =>
        await new Promise((_, reject) => {
          options.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
            once: true,
          });
        }),
    );
    try {
      await expect(
        assertRuntimeAthleteOwner(
          value.store,
          {
            current: {
              apiKey: "current-key",
              athleteId: "current-athlete",
              historyNewestDate: "1900-12-31",
              clock: { now: clock.now, monotonicNow: () => performance.now() },
            },
            candidate: {
              apiKey: "candidate-key",
              athleteId: "candidate-athlete",
              historyNewestDate: "1900-12-31",
              clock: { now: clock.now, monotonicNow: () => performance.now() },
            },
            signal: new AbortController().signal,
            timeoutMs: 5,
          },
          resolveFingerprint,
        ),
      ).rejects.toMatchObject({ reason: "current-unresolved" });
      expect(await value.store.get("SELECT count(*) AS count FROM store_owner")).toEqual({
        count: 0,
      });
    } finally {
      await value.store.close();
    }
  });

  it("distinguishes unresolved current and candidate ownership", async () => {
    const currentUnresolved = await fresh();
    try {
      await expect(
        assertRuntimeAthleteOwner(
          currentUnresolved.store,
          {
            current: {
              apiKey: "current-key",
              athleteId: "current-athlete",
              historyNewestDate: "1900-12-31",
              clock,
            },
            candidate: {
              apiKey: "candidate-key",
              athleteId: "candidate-athlete",
              historyNewestDate: "1900-12-31",
              clock,
            },
            signal: new AbortController().signal,
          },
          async () => null,
        ),
      ).rejects.toMatchObject({ reason: "current-unresolved" });
      expect(
        await currentUnresolved.store.get("SELECT count(*) AS count FROM store_owner"),
      ).toEqual({
        count: 0,
      });
    } finally {
      await currentUnresolved.store.close();
    }

    const candidateUnresolved = await fresh();
    const fingerprint = "a".repeat(64);
    const resolveFingerprint = vi
      .fn()
      .mockResolvedValueOnce(fingerprint)
      .mockRejectedValueOnce(new Error("synthetic candidate lookup failure"));
    try {
      await expect(
        assertRuntimeAthleteOwner(
          candidateUnresolved.store,
          {
            current: {
              apiKey: "current-key",
              athleteId: "current-athlete",
              historyNewestDate: "1900-12-31",
              clock,
            },
            candidate: {
              apiKey: "candidate-key",
              athleteId: "candidate-athlete",
              historyNewestDate: "1900-12-31",
              clock,
            },
            signal: new AbortController().signal,
          },
          resolveFingerprint,
        ),
      ).rejects.toMatchObject({ reason: "candidate-unresolved" });
      expect(
        await candidateUnresolved.store.get("SELECT account_fingerprint FROM store_owner"),
      ).toEqual({
        account_fingerprint: fingerprint,
      });
    } finally {
      await candidateUnresolved.store.close();
    }
  });

  it("refuses a candidate whose resolved owner differs from the current owner", async () => {
    const value = await fresh();
    const currentFingerprint = "a".repeat(64);
    const candidateFingerprint = "b".repeat(64);
    const resolveFingerprint = vi
      .fn()
      .mockResolvedValueOnce(currentFingerprint)
      .mockResolvedValueOnce(candidateFingerprint);
    try {
      await expect(
        assertRuntimeAthleteOwner(
          value.store,
          {
            current: {
              apiKey: "current-key",
              athleteId: "current-athlete",
              historyNewestDate: "1900-12-31",
              clock,
            },
            candidate: {
              apiKey: "candidate-key",
              athleteId: "candidate-athlete",
              historyNewestDate: "1900-12-31",
              clock,
            },
            signal: new AbortController().signal,
          },
          resolveFingerprint,
        ),
      ).rejects.toMatchObject({ reason: "mismatch" });
      expect(await value.store.get("SELECT account_fingerprint FROM store_owner")).toEqual({
        account_fingerprint: currentFingerprint,
      });
    } finally {
      await value.store.close();
    }
  });

  it("claims an upgraded store without re-walking or changing its existing history", async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "backfill-upgrade-"));
    roots.push(root);
    const home = athleteHome(root, join(root, "store"));
    mkdirSync(home.storeDir, { recursive: true, mode: 0o700 });
    const storePath = join(home.storeDir, "store.db");
    const legacy = openSqliteStorage(storePath);
    await runMigrations(legacy, MIGRATIONS.slice(0, 7));
    await legacy.run(
      "INSERT INTO workout(workout_key,start_utc,is_multisport,dedup_cluster_id) VALUES(?,?,0,?)",
      ["synthetic-workout", 1_262_304_000, "synthetic-cluster"],
    );
    await legacy.run(
      "INSERT INTO session(session_key,workout_key,session_seq,sport,start_utc,local_date_key,is_transition) VALUES(?,?,0,?,?,?,0)",
      ["synthetic-session", "synthetic-workout", "cycling", 1_262_304_000, 20100101],
    );
    await legacy.transaction(async () => {
      await createSyncStateRepository(legacy).recordCompletionInTransaction({
        source: "intervals-icu",
        lane: "bulk-fit",
        watermarkBefore: null,
        watermarkAfter: complete,
        artifactsSeen: 0,
        sourceChanges: 0,
      });
    });
    const before = await dumpStore(legacy);
    await legacy.close();
    const baseFetch = profileFetch("synthetic-athlete-upgrade");

    await runIntervalsBackfill({
      env: { ENDURAGENT_HOME: root },
      apiKey: "synthetic-upgrade",
      athleteId: "0",
      historyNewestDate: "2010-12-31",
      clock,
      sleep: async () => {},
      baseFetch,
    });

    expect(baseFetch).toHaveBeenCalledOnce();
    const upgraded = openSqliteStorage(storePath);
    try {
      expect(await upgraded.get("PRAGMA user_version")).toEqual({ user_version: 9 });
      expect(await upgraded.get("SELECT count(*) AS count FROM store_owner")).toEqual({ count: 1 });
      expect(await dumpStore(upgraded)).toBe(before);
    } finally {
      await upgraded.close();
    }
    await expect(
      checkIntervalsStoreOwnerAtPath(storePath, {
        apiKey: "synthetic-other",
        athleteId: "0",
        historyNewestDate: "2010-12-31",
        clock,
        sleep: async () => {},
        baseFetch: profileFetch("synthetic-athlete-other"),
      }),
    ).resolves.toBe("mismatch");
  });

  it("refuses a different athlete before writing any sync state or training data", async () => {
    const value = await fresh();
    try {
      await syncInWriter(value, "synthetic-athlete-owner", "synthetic-owner");
      const before = await storedSyncState(value.store);
      const mismatchRequests: BackfillRequest[] = [];
      const mismatchFetch = profileFetch("synthetic-athlete-other", mismatchRequests);

      await expect(
        syncInWriterWithFetch(value, "synthetic-other", mismatchFetch),
      ).rejects.toThrow("training account mismatch");

      expect(mismatchRequests.filter(({ endpoint }) => endpoint === "profile")).toHaveLength(1);
      expect(mismatchRequests.filter(({ endpoint }) => endpoint === "activities")).toHaveLength(0);
      expect(await storedSyncState(value.store)).toEqual(before);
    } finally {
      await value.store.close();
    }
  });

  it("continues sync when profile sport settings cannot resolve an owner", async () => {
    const value = await fresh();
    const requests: BackfillRequest[] = [];
    const baseFetch = unresolvedProfileFetch(requests);
    try {
      const sync = await syncInWriterWithFetch(value, "synthetic-unresolved", baseFetch);

      expect(sync.result).toMatchObject({ pages: 2, artifacts: 0, reports: [] });
      expect(requests.map(({ endpoint }) => endpoint)).toEqual(["profile", "activities"]);
      expect(await value.store.get("SELECT count(*) AS count FROM store_owner")).toEqual({
        count: 0,
      });
    } finally {
      await value.store.close();
    }
  });

  it("syncs the same athlete normally without re-walking completed history", async () => {
    const value = await fresh();
    try {
      const first = await syncInWriter(value, "synthetic-athlete-owner");
      const repeat = await syncInWriter(value, "synthetic-athlete-owner");

      expect(repeat.result).toMatchObject({ pages: 2, artifacts: 0, reports: [] });
      expect(first.baseFetch).toHaveBeenCalledTimes(2);
      expect(repeat.baseFetch).toHaveBeenCalledOnce();
      expect(await value.store.get("SELECT count(*) AS count FROM store_owner")).toEqual({
        count: 1,
      });
    } finally {
      await value.store.close();
    }
  });

  it("keeps an ownerless store unclaimed during the save-time convenience check", async () => {
    const value = await fresh();
    const storePath = join(value.root, "store.db");
    await value.store.close();
    const baseFetch = profileFetch("synthetic-athlete-ownerless");

    await expect(
      checkIntervalsStoreOwnerAtPath(storePath, {
        apiKey: "synthetic-ownerless",
        athleteId: "0",
        historyNewestDate: "1900-12-31",
        clock,
        sleep: async () => {},
        baseFetch,
      }),
    ).resolves.toBe("unowned");
    expect(baseFetch).not.toHaveBeenCalled();

    const reopened = openSqliteStorage(storePath);
    try {
      expect(await reopened.get("SELECT count(*) AS count FROM store_owner")).toEqual({ count: 0 });
    } finally {
      await reopened.close();
    }
  });

  it("skips identity resolution when the save-time store is unavailable", async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "backfill-save-check-"));
    roots.push(root);
    const storePath = join(root, "missing", "store.db");
    const baseFetch = profileFetch("synthetic-athlete-resolved");

    await expect(
      checkIntervalsStoreOwnerAtPath(storePath, {
        apiKey: "synthetic-resolved",
        athleteId: "0",
        historyNewestDate: "1900-12-31",
        clock,
        sleep: async () => {},
        baseFetch,
      }),
    ).resolves.toBe("store-unavailable");
    expect(baseFetch).not.toHaveBeenCalled();
  });

  it("allows save when an owned store identity cannot be resolved", async () => {
    const value = await fresh();
    try {
      await syncInWriter(value, "synthetic-athlete-owner");
      const baseFetch = unresolvedProfileFetch();
      await expect(
        checkIntervalsStoreOwnerAtPath(join(value.root, "store.db"), {
          apiKey: "synthetic-unresolved",
          athleteId: "0",
          historyNewestDate: "1900-12-31",
          clock,
          sleep: async () => {},
          baseFetch,
        }),
      ).resolves.toBe("unresolved");
      expect(baseFetch).toHaveBeenCalledOnce();
    } finally {
      await value.store.close();
    }
  });

  it("accepts a rotated credential for the same athlete at save time and sync time", async () => {
    const value = await fresh();
    try {
      await syncInWriter(value, "synthetic-athlete-owner", "synthetic-old");
      const saveFetch = profileFetch("synthetic-athlete-owner");
      await expect(
        checkIntervalsStoreOwnerAtPath(join(value.root, "store.db"), {
          apiKey: "synthetic-new",
          athleteId: "0",
          historyNewestDate: "1900-12-31",
          clock,
          sleep: async () => {},
          baseFetch: saveFetch,
        }),
      ).resolves.toBe("matched");
      const sync = await syncInWriter(value, "synthetic-athlete-owner", "synthetic-new");
      expect(sync.result).toMatchObject({ pages: 2, artifacts: 0 });
      expect(saveFetch).toHaveBeenCalledOnce();
      expect(sync.baseFetch).toHaveBeenCalledOnce();
    } finally {
      await value.store.close();
    }
  });

  it("keeps the public writer wrapper equivalent to the supplied-writer entry", async () => {
    const makeHome = async (): Promise<{
      home: AthleteHome;
      store: ReturnType<typeof openSqliteStorage>;
    }> => {
      const root = mkdtempSync(join(realpathSync(tmpdir()), "backfill-writer-"));
      roots.push(root);
      const home = {
        root,
        storeDir: join(root, "store"),
        archiveDir: join(root, "archive"),
        configDir: join(root, "config"),
      };
      mkdirSync(home.storeDir, { recursive: true, mode: 0o700 });
      const store = openSqliteStorage(join(home.storeDir, "store.db"));
      await runMigrations(store, MIGRATIONS);
      await store.transaction(async () => {
        await createSyncStateRepository(store).recordCompletionInTransaction({
          source: "intervals-icu",
          lane: "bulk-fit",
          watermarkBefore: null,
          watermarkAfter: complete,
          artifactsSeen: 0,
          sourceChanges: 0,
        });
      });
      return { home, store };
    };
    const direct = await makeHome();
    const wrapped = await makeHome();
    const directPages: unknown[] = [];
    const wrappedPages: unknown[] = [];
    const baseFetch = profileFetch("synthetic-athlete");
    const close = vi.spyOn(direct.store, "close");
    try {
      const directResult = await runIntervalsBackfillInWriter({
        home: direct.home,
        store: direct.store,
        apiKey: String.fromCharCode(116, 101, 115, 116),
        athleteId: "synthetic-athlete",
        historyNewestDate: "2010-12-31",
        clock,
        sleep: async () => {},
        baseFetch,
        onPageCommitted: (page) => directPages.push(page),
      });
      await wrapped.store.close();
      const wrappedResult = await runIntervalsBackfill({
        env: { ENDURAGENT_HOME: wrapped.home.root },
        apiKey: String.fromCharCode(116, 101, 115, 116),
        athleteId: "synthetic-athlete",
        historyNewestDate: "2010-12-31",
        clock,
        sleep: async () => {},
        baseFetch,
        onPageCommitted: (page) => wrappedPages.push(page),
      });
      expect(wrappedResult).toEqual(directResult);
      expect(wrappedPages).toEqual(directPages);
      expect(directResult).toMatchObject({ pages: 2, artifacts: 0, reports: [] });
      expect(baseFetch).toHaveBeenCalledTimes(2);
      expect(close).not.toHaveBeenCalled();
      await expect(
        direct.store.get("SELECT count(*) AS count FROM source_watermark"),
      ).resolves.toEqual({ count: 1 });
    } finally {
      close.mockRestore();
      await direct.store.close();
    }
  });

  it("preserves in-writer bounds and leaves the caller store open after rejection", async () => {
    const value = await fresh();
    const home: AthleteHome = {
      root: value.root,
      storeDir: join(value.root, "store"),
      archiveDir: join(value.root, "archive"),
      configDir: join(value.root, "config"),
    };
    const close = vi.spyOn(value.store, "close");
    try {
      await expect(
        runIntervalsBackfillInWriter({
          home,
          store: value.store,
          apiKey: String.fromCharCode(116, 101, 115, 116),
          athleteId: "synthetic-athlete",
          historyNewestDate: "2010-12-31",
          batchSize: 0,
        }),
      ).rejects.toThrow("invalid batch size");
      expect(close).not.toHaveBeenCalled();
      await expect(
        value.store.get("SELECT count(*) AS count FROM source_watermark"),
      ).resolves.toEqual({ count: 0 });
    } finally {
      close.mockRestore();
      await value.store.close();
    }
  });
});
