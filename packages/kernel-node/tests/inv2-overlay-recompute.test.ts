import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArchiveManager } from "@enduragent/kernel/archive";
import type { CryptoPort } from "@enduragent/kernel/ports";
import { dumpStore, runMigrations, type MigratorStore, type SqlStore } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";

const rebuildProbe = vi.hoisted(() => ({
  internal: [] as string[],
  public: 0,
  versions: [] as unknown[],
  failAt: null as number | null,
}));

vi.mock("@enduragent/kernel/ingest", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@enduragent/kernel/ingest")>();
  return {
    ...actual,
    async rebuildRawFileInTransaction(
      ...args: Parameters<typeof actual.rebuildRawFileInTransaction>
    ): ReturnType<typeof actual.rebuildRawFileInTransaction> {
      const [store, artifact] = args;
      rebuildProbe.internal.push(artifact.rawFile.sha256);
      rebuildProbe.versions.push((await store.get("SELECT ingest_version FROM ingest_metadata WHERE singleton=1"))?.ingest_version);
      if (rebuildProbe.failAt === rebuildProbe.internal.length) throw new Error("injected rebuild failure");
      return actual.rebuildRawFileInTransaction(...args);
    },
    async rebuildRawFile(
      ...args: Parameters<typeof actual.rebuildRawFile>
    ): ReturnType<typeof actual.rebuildRawFile> {
      rebuildProbe.public += 1;
      return actual.rebuildRawFile(...args);
    },
  };
});

import { createArchivedArtifactReconstructor } from "../src/ingest/index.js";
import { createFitDecoder, type FitDecoder } from "../src/ingest/fit-decoder.js";
import { importFitArtifact } from "../src/ingest/fit-import.js";
import { ensureCurrentIngestVersion } from "../src/ingest/ingest-version.js";
import { openSqliteStorage } from "../src/sqlite/index.js";

const crypto: CryptoPort = {
  async sha256(data) { return new Uint8Array(createHash("sha256").update(data).digest()); },
  async randomBytes() { throw new Error("unused"); }, async pbkdf2() { throw new Error("unused"); },
  async aesGcmEncrypt() { throw new Error("unused"); }, async aesGcmDecrypt() { throw new Error("unused"); },
};

const fixture = (name: string): Uint8Array => new Uint8Array(
  readFileSync(resolve(`packages/kernel-node/tests/fixtures/ingest/${name}`)),
);
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

interface MemoryArchive {
  readonly manager: ArchiveManager;
  readonly reads: string[];
  put(bytes: Uint8Array, ext: "fit" | "tcx" | "gpx"): { readonly sha: string; readonly path: string };
}

function createMemoryArchive(): MemoryArchive {
  const files = new Map<string, Uint8Array>();
  const reads: string[] = [];
  const put = (bytes: Uint8Array, ext: "fit" | "tcx" | "gpx") => {
    const sha = sha256(bytes);
    const path = `archive/${sha}.${ext}`;
    files.set(path, new Uint8Array(bytes));
    return { sha, path };
  };
  return {
    reads,
    put,
    manager: {
      async writeArtifact(bytes, ext) {
        if (ext !== "fit" && ext !== "tcx" && ext !== "gpx") throw new Error("unsupported test artifact extension");
        const prior = files.has(`archive/${sha256(bytes)}.${ext}`);
        const stored = put(bytes, ext);
        return { address: stored.sha, relPath: stored.path, deduped: prior };
      },
      async quarantine(bytes, ext) {
        if (ext !== "fit" && ext !== "tcx" && ext !== "gpx") throw new Error("unsupported test artifact extension");
        const stored = put(bytes, ext);
        return { address: stored.sha, relPath: stored.path, deduped: false };
      },
      async readArtifact(path) {
        reads.push(path);
        const bytes = files.get(path);
        if (bytes === undefined) throw new Error("missing archive artifact");
        return new Uint8Array(bytes);
      },
      async writeSnapshot() { throw new Error("unused"); },
      async readSnapshot() { throw new Error("unused"); },
      async has(path) { return files.has(path); },
    },
  };
}

function resetRebuildProbe(): void {
  rebuildProbe.internal.length = 0;
  rebuildProbe.public = 0;
  rebuildProbe.versions.length = 0;
  rebuildProbe.failAt = null;
}

describe("production ingest-version overlay recompute", () => {
  let store: SqlStore & MigratorStore;
  let archive: MemoryArchive;
  const tempDirectories = new Set<string>();

  beforeEach(async () => {
    resetRebuildProbe();
    archive = createMemoryArchive();
    store = openSqliteStorage(":memory:");
    await runMigrations(store, MIGRATIONS);
  });

  afterEach(async () => {
    await store.close();
    for (const path of tempDirectories) rmSync(path, { recursive: true, force: true });
    tempDirectories.clear();
  });

  function reconstructor(decodedOrder: string[] = [], decoder: FitDecoder = createFitDecoder()) {
    return createArchivedArtifactReconstructor({
      crypto,
      decoder: {
        async decode(bytes) {
          decodedOrder.push(sha256(bytes));
          return decoder.decode(bytes);
        },
      },
    });
  }

  async function importFits(names: readonly string[], target = store): Promise<string[]> {
    const imported: string[] = [];
    for (const name of names) {
      const result = await importFitArtifact(fixture(name), {
        archive: archive.manager,
        crypto,
        store: target,
        decoder: createFitDecoder(),
        reconstructArchivedArtifact: reconstructor(),
      });
      if (result.kind !== "imported") throw new Error("synthetic FIT fixture was quarantined");
      imported.push(result.rawSha256);
    }
    return imported;
  }

  async function seedXml(name: string, format: "tcx" | "gpx"): Promise<void> {
    const bytes = fixture(name);
    const stored = archive.put(bytes, format);
    await store.run("INSERT INTO raw_file(sha256,path,ext,bytes) VALUES(?,?,?,?)", [stored.sha, stored.path, format, bytes.byteLength]);
  }

  async function inventory(target = store): Promise<{ sha: string; path: string }[]> {
    return (await target.all("SELECT sha256, path FROM raw_file ORDER BY sha256 ASC"))
      .map((row) => ({ sha: row.sha256 as string, path: row.path as string }));
  }

  function countTransactions(target = store): () => number {
    let count = 0;
    const original = target.transaction.bind(target);
    target.transaction = async (fn) => { count += 1; return original(fn); };
    return () => count;
  }

  it("authored pool overlay survives production 0→1 rebuild", async () => {
    const [fitSha] = await importFits(["pool-size-correction.fit"]);
    await seedXml("fallback-cycling.tcx", "tcx");
    await seedXml("fallback-cycling.gpx", "gpx");
    const session = await store.get("SELECT session_key FROM session");
    const sessionKey = session?.session_key as string;
    await store.run(
      "INSERT INTO pool_size_correction_overlay(id,target_session_key,corrected_pool_length_m,device_id,hlc_physical_ms,hlc_counter) VALUES(?,?,?,?,?,?)",
      ["o", sessionKey, 50, "d", 2, 1],
    );
    const overlayBefore = await store.get("SELECT * FROM pool_size_correction_overlay");
    const logsBefore = await store.all("SELECT * FROM repair_log ORDER BY repair_key");
    await store.run("UPDATE ingest_metadata SET ingest_version=0");
    const expected = await inventory();
    archive.reads.length = 0;
    resetRebuildProbe();
    const decodedOrder: string[] = [];
    const transactions = countTransactions();
    expect(await ensureCurrentIngestVersion({ store, archive: archive.manager, crypto, reconstructArchivedArtifact: reconstructor(decodedOrder) }))
      .toEqual({ rebuilt: true, from: 0, to: 1 });
    expect(archive.reads).toEqual(expected.map((row) => row.path));
    expect(decodedOrder).toEqual([fitSha]);
    expect(rebuildProbe.internal).toEqual([fitSha]);
    expect(rebuildProbe.public).toBe(0);
    expect(rebuildProbe.versions).toEqual([0]);
    expect(transactions()).toBe(1);
    expect(await store.get("SELECT * FROM pool_size_correction_overlay")).toEqual(overlayBefore);
    expect(await store.get("SELECT distance_m FROM session WHERE session_key=?", [sessionKey])).toEqual({ distance_m: 200 });
    expect((await store.all("SELECT distance_m FROM swim_length ORDER BY length_key")).map((row) => row.distance_m)).toEqual([50, 50, 50, 50]);
    expect(await store.all("SELECT * FROM repair_log ORDER BY repair_key")).toEqual(logsBefore);
    expect(await store.get("SELECT ingest_version FROM ingest_metadata WHERE singleton=1")).toEqual({ ingest_version: 1 });
  });

  it("returns a byte-identical no-op at version 1", async () => {
    await importFits(["brick-cycling.fit"]);
    const before = await dumpStore(store);
    archive.reads.length = 0;
    resetRebuildProbe();
    const decodedOrder: string[] = [];
    const transactions = countTransactions();
    expect(await ensureCurrentIngestVersion({ store, archive: archive.manager, crypto, reconstructArchivedArtifact: reconstructor(decodedOrder) }))
      .toEqual({ rebuilt: false, from: 1, to: 1 });
    expect(archive.reads).toEqual([]);
    expect(decodedOrder).toEqual([]);
    expect(rebuildProbe.internal).toEqual([]);
    expect(rebuildProbe.public).toBe(0);
    expect(transactions()).toBe(0);
    expect(await dumpStore(store)).toBe(before);
  });

  it("refuses a newer ingest version before archive or SQL work", async () => {
    await store.run("UPDATE ingest_metadata SET ingest_version=2");
    archive.reads.length = 0;
    resetRebuildProbe();
    const transactions = countTransactions();
    await expect(ensureCurrentIngestVersion({ store, archive: archive.manager, crypto, reconstructArchivedArtifact: reconstructor() }))
      .rejects.toThrow("newer ingest semantics");
    expect(archive.reads).toEqual([]);
    expect(rebuildProbe.internal).toEqual([]);
    expect(rebuildProbe.public).toBe(0);
    expect(transactions()).toBe(0);
  });

  it("rolls back derived deletes and file-one writes when file two rebuild fails", async () => {
    await importFits(["brick-cycling.fit", "brick-running.fit", "pool-size-correction.fit"]);
    await store.run("UPDATE ingest_metadata SET ingest_version=0");
    const before = await dumpStore(store);
    const expected = await inventory();
    archive.reads.length = 0;
    resetRebuildProbe();
    rebuildProbe.failAt = 2;
    const decodedOrder: string[] = [];
    const transactions = countTransactions();
    await expect(ensureCurrentIngestVersion({ store, archive: archive.manager, crypto, reconstructArchivedArtifact: reconstructor(decodedOrder) }))
      .rejects.toThrow("injected rebuild failure");
    expect(archive.reads).toEqual(expected.map((row) => row.path));
    expect(decodedOrder).toEqual(expected.map((row) => row.sha));
    expect(rebuildProbe.internal).toEqual(expected.slice(0, 2).map((row) => row.sha));
    expect(rebuildProbe.public).toBe(0);
    expect(rebuildProbe.versions).toEqual([0, 0]);
    expect(transactions()).toBe(1);
    expect(await dumpStore(store)).toBe(before);
    expect((await store.get("SELECT ingest_version FROM ingest_metadata"))?.ingest_version).toBe(0);
  });

  it("uses SHA order, one outer transaction, internal rebuilds only, and metadata last", async () => {
    await importFits(["pool-size-correction.fit", "brick-running.fit", "brick-cycling.fit"]);
    await store.run("UPDATE ingest_metadata SET ingest_version=0");
    const expected = await inventory();
    archive.reads.length = 0;
    resetRebuildProbe();
    const decodedOrder: string[] = [];
    const transactions = countTransactions();
    expect(await ensureCurrentIngestVersion({ store, archive: archive.manager, crypto, reconstructArchivedArtifact: reconstructor(decodedOrder) }))
      .toEqual({ rebuilt: true, from: 0, to: 1 });
    expect(archive.reads).toEqual(expected.map((row) => row.path));
    expect(decodedOrder).toEqual(expected.map((row) => row.sha));
    expect(rebuildProbe.internal).toEqual(expected.map((row) => row.sha));
    expect(rebuildProbe.public).toBe(0);
    expect(rebuildProbe.versions).toEqual([0, 0, 0]);
    expect(transactions()).toBe(1);
    expect((await store.get("SELECT ingest_version FROM ingest_metadata"))?.ingest_version).toBe(1);
  });

  it("prevents a stale slow ensure from deleting a post-ensure guarded import", async () => {
    await store.close();
    const directory = mkdtempSync(join(tmpdir(), "ingest-version-race-"));
    tempDirectories.add(directory);
    const path = join(directory, "store.db");
    store = openSqliteStorage(path);
    await runMigrations(store, MIGRATIONS);
    const competing = openSqliteStorage(path);
    try {
      await importFits(["brick-cycling.fit"], store);
      await store.run("UPDATE ingest_metadata SET ingest_version=0");
      let reached!: () => void;
      let release!: () => void;
      const reconstructing = new Promise<void>((resolveReached) => { reached = resolveReached; });
      const continueReconstruction = new Promise<void>((resolveRelease) => { release = resolveRelease; });
      const decoder = createFitDecoder();
      const slowDecoder: FitDecoder = {
        async decode(bytes) {
          reached();
          await continueReconstruction;
          return decoder.decode(bytes);
        },
      };
      const slowEnsure = ensureCurrentIngestVersion({
        store,
        archive: archive.manager,
        crypto,
        reconstructArchivedArtifact: reconstructor([], slowDecoder),
      });
      await reconstructing;
      expect(await ensureCurrentIngestVersion({ store: competing, archive: archive.manager, crypto, reconstructArchivedArtifact: reconstructor() }))
        .toEqual({ rebuilt: true, from: 0, to: 1 });
      const imported = await importFitArtifact(fixture("brick-running.fit"), {
        archive: archive.manager,
        crypto,
        store: competing,
        decoder: createFitDecoder(),
        reconstructArchivedArtifact: reconstructor(),
      });
      expect(imported).toMatchObject({ kind: "imported", rawInserted: true });
      const beforeSlowCommit = await dumpStore(competing);
      release();
      expect(await slowEnsure).toEqual({ rebuilt: false, from: 1, to: 1 });
      expect(await dumpStore(competing)).toBe(beforeSlowCommit);
      expect((await competing.get("SELECT count(*) AS count FROM raw_file"))?.count).toBe(2);
      expect(Number((await competing.get("SELECT count(*) AS count FROM session"))?.count)).toBeGreaterThanOrEqual(2);
    } finally {
      await competing.close();
    }
  });
});
