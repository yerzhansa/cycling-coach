import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { H } from "@enduragent/kernel/store";
import { createRepairLogRepository, runMigrations, type MigratorStore, type RepairLogInsert, type SqlStore } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import type { CryptoPort } from "@enduragent/kernel/ports";
import { openSqliteStorage } from "../src/sqlite/index.js";

const crypto: CryptoPort = {
  async sha256(data) { return new Uint8Array(createHash("sha256").update(data).digest()); },
  async randomBytes() { throw new Error("unused"); }, async pbkdf2() { throw new Error("unused"); },
  async aesGcmEncrypt() { throw new Error("unused"); }, async aesGcmDecrypt() { throw new Error("unused"); },
};
const rawSha256 = "01".repeat(32);
const params = {
  chronoBridge: { boundaryPolicy: "bounded-only", interpolation: "linear", maxMissingSeconds: 5 },
  summitGuard: { convergence: "fixed-point", madScale: 1.4826, powerFloorWatts: 50, speedFloorMps: 2, thresholdScaledMad: 3, windowSamples: 7 },
  pulseWeave: { boundaryPolicy: "bounded-only", convergence: "fixed-point", flatlineBoundaryDeltaBpm: 5, flatlineMinSeconds: 10, interpolation: "linear", maxRepairSeconds: 30, plausibleBpm: [35, 230], zeroOrImplausibleMaxBpm: 30, zeroRunMinSeconds: 2 },
} as const;

describe("repair log repository", () => {
  let store: SqlStore & MigratorStore;
  beforeEach(async () => {
    store = openSqliteStorage(":memory:");
    await runMigrations(store, MIGRATIONS);
    await store.run("INSERT INTO raw_file(sha256,path,ext,bytes) VALUES(?,?,?,?)", [rawSha256, "x.fit", "fit", 1]);
    await store.run("INSERT INTO workout(workout_key,start_utc,is_multisport,dedup_cluster_id) VALUES('w',0,0,'d')");
    await store.run("INSERT INTO session(session_key,workout_key,session_seq,sport,start_utc,local_date_key,is_transition) VALUES('s','w',0,'cycling',0,19700101,0)");
  });
  afterEach(async () => store.close());
  const insert = (overrides: Partial<RepairLogInsert> = {}): RepairLogInsert => ({ rawSha256, sessionKey: "s", channel: "power", fixer: "summitGuard", changedIndices: [3, 7], params: params.summitGuard, ...overrides });

  it("inserts the exact computed key and canonical JSON", async () => {
    await createRepairLogRepository(store, crypto).insertOrAssertIdentical(insert());
    expect(await store.get("SELECT * FROM repair_log")).toEqual({
      repair_key: await H(crypto, "repair_log", rawSha256, "s", "power", "summitGuard"), raw_sha256: rawSha256,
      session_key: "s", channel: "power", fixer: "summitGuard", changed_count: 2, changed_indices_json: "[3,7]",
      params_json: JSON.stringify(params.summitGuard),
    });
  });

  it("accepts an identical retry without changing rows", async () => {
    const repo = createRepairLogRepository(store, crypto);
    await repo.insertOrAssertIdentical(insert()); const before = await store.all("SELECT * FROM repair_log");
    await repo.insertOrAssertIdentical(insert()); expect(await store.all("SELECT * FROM repair_log")).toEqual(before);
  });

  it("rejects deterministic-content mismatch", async () => {
    const repo = createRepairLogRepository(store, crypto); await repo.insertOrAssertIdentical(insert());
    const before = await store.all("SELECT * FROM repair_log");
    await expect(repo.insertOrAssertIdentical(insert({ changedIndices: [3] }))).rejects.toThrow("repair log invariant mismatch");
    expect(await store.all("SELECT * FROM repair_log")).toEqual(before);
  });

  it("rejects a primary-key collision with a different tuple", async () => {
    const key = await H(crypto, "repair_log", rawSha256, "s", "power", "summitGuard");
    await store.run("INSERT INTO repair_log VALUES(?,?,?,?,?,?,?,?)", [key, rawSha256, "s", "speed", "summitGuard", 0, "[]", JSON.stringify(params.summitGuard)]);
    const before = await store.all("SELECT * FROM repair_log");
    await expect(createRepairLogRepository(store, crypto).insertOrAssertIdentical(insert())).rejects.toThrow();
    expect(await store.all("SELECT * FROM repair_log")).toEqual(before);
  });

  it("rolls back the outer transaction when a mismatch occurs", async () => {
    const repo = createRepairLogRepository(store, crypto); await repo.insertOrAssertIdentical(insert());
    const before = await store.all("SELECT * FROM repair_log ORDER BY repair_key");
    await expect(store.transaction(async () => {
      await repo.insertOrAssertIdentical(insert({ channel: "speed", changedIndices: [], params: params.summitGuard }));
      await repo.insertOrAssertIdentical(insert({ changedIndices: [9] }));
    })).rejects.toThrow();
    expect(await store.all("SELECT * FROM repair_log ORDER BY repair_key")).toEqual(before);
  });

  it("rejects every invalid structured value without changing SQL", async () => {
    const sparse = [1, 2]; delete sparse[0];
    const extraIndexProperty = [3, 7] as number[] & { extra?: number };
    extraIndexProperty.extra = 1;
    const hiddenParams = { ...params.summitGuard };
    Object.defineProperty(hiddenParams, "hidden", { value: 1, enumerable: false });
    const accessorParams = { ...params.summitGuard };
    Object.defineProperty(accessorParams, "extra", { get: () => 1, enumerable: true });
    const symbolParams = { ...params.summitGuard };
    Object.defineProperty(symbolParams, Symbol("extra"), { value: 1, enumerable: true });
    const prototypeNamedParams = { ...params.summitGuard };
    Object.defineProperty(prototypeNamedParams, "__proto__", { value: { dropped: true }, enumerable: true });
    const plausibleBpm = [...params.pulseWeave.plausibleBpm] as number[] & { extra?: number };
    plausibleBpm.extra = 1;
    const invalid: Partial<RepairLogInsert>[] = [
      { changedIndices: undefined }, { changedIndices: sparse }, { changedIndices: [NaN] }, { changedIndices: [Infinity] },
      { changedIndices: [1n] }, { changedIndices: [() => 1] }, { changedIndices: [Symbol("x")] },
      { params: new Date(0) }, { changedIndices: [2, 1] }, { changedIndices: [1, 1] }, { changedIndices: [-1] },
      { changedIndices: [Number.MAX_SAFE_INTEGER + 1] }, { params: { ...params.summitGuard, extra: undefined } },
      { params: { ...params.summitGuard, extra: NaN } }, { params: { ...params.summitGuard, extra: 1n } },
      { params: { ...params.summitGuard, extra: () => 1 } }, { params: { ...params.summitGuard, extra: Symbol("x") } },
      { changedIndices: extraIndexProperty }, { params: hiddenParams }, { params: accessorParams }, { params: symbolParams },
      { params: prototypeNamedParams },
      { fixer: "pulseWeave", params: { ...params.pulseWeave, plausibleBpm } },
    ];
    for (const [index, override] of invalid.entries()) {
      const before = await store.all("SELECT * FROM repair_log");
      let rejected: unknown;
      try {
        await createRepairLogRepository(store, crypto).insertOrAssertIdentical(insert(override));
      } catch (error) {
        rejected = error;
      }
      if (rejected === undefined) throw new Error(`invalid structured value ${index} was accepted`);
      expect(await store.all("SELECT * FROM repair_log")).toEqual(before);
    }
  });

  it("rejects an unknown fixer through a runtime cast", async () => {
    await expect(createRepairLogRepository(store, crypto).insertOrAssertIdentical(insert({ fixer: "unknown" as never }))).rejects.toThrow("unknown repair fixer");
    expect(await store.all("SELECT * FROM repair_log")).toEqual([]);
  });

  it("rejects cross-wired fixer parameters", async () => {
    await expect(createRepairLogRepository(store, crypto).insertOrAssertIdentical(insert({ params: params.chronoBridge }))).rejects.toThrow("repair params do not match fixer");
    expect(await store.all("SELECT * FROM repair_log")).toEqual([]);
  });

  it("rejects a preseeded tuple with a well-formed wrong repair key", async () => {
    await store.run("INSERT INTO repair_log VALUES(?,?,?,?,?,?,?,?)", ["ab".repeat(32), rawSha256, "s", "power", "summitGuard", 2, "[3,7]", JSON.stringify(params.summitGuard)]);
    const before = await store.all("SELECT * FROM repair_log");
    await expect(createRepairLogRepository(store, crypto).insertOrAssertIdentical(insert())).rejects.toThrow();
    expect(await store.all("SELECT * FROM repair_log")).toEqual(before);
  });
});
