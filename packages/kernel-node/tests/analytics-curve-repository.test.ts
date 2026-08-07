import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ANALYTICS_CURVE_PARTS,
  analyticsCurveWindows,
  createAnalyticsCurveRepository,
  runMigrations,
  type AnalyticsCurveRepository,
  type MigratorStore,
  type SqlStore,
} from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { openSqliteStorage } from "../src/sqlite/index.js";

const FROZEN_ON = "2026-08-07";
const FROZEN_EPOCH_SECONDS = Date.parse(`${FROZEN_ON}T12:00:00.000Z`) / 1_000;

async function hashKey(fields: readonly (string | number)[]): Promise<string> {
  return createHash("sha256").update(JSON.stringify(fields)).digest("hex");
}

describe("analytics curve repository", () => {
  let store: SqlStore & MigratorStore;
  let repository: AnalyticsCurveRepository;

  beforeEach(async () => {
    store = openSqliteStorage(":memory:");
    await runMigrations(store, MIGRATIONS);
    repository = createAnalyticsCurveRepository(store, hashKey);
  });

  afterEach(async () => {
    await store.close();
  });

  async function begin(day = FROZEN_ON, hour = 12) {
    return repository.beginGeneration({
      frozenOn: day,
      frozenEpochSeconds: Date.parse(`${day}T${String(hour).padStart(2, "0")}:00:00.000Z`) / 1_000,
    });
  }

  async function recordAll(
    generationId: string,
    offset = 0,
    archiveEpochSeconds = FROZEN_EPOCH_SECONDS,
  ): Promise<void> {
    for (const [index, part] of ANALYTICS_CURVE_PARTS.entries()) {
      const archiveAddress = (index + offset + 1).toString(16).padStart(64, "0");
      await repository.recordEvidence({
        generationId,
        ...part,
        archiveAddress,
        archiveRelPath: `2026/08/${archiveAddress}.json.gz`,
        archiveEpochSeconds,
        decodedBytes: 100 + index,
      });
    }
  }

  it("derives exact adjacent windows and idempotently begins one immutable generation", async () => {
    expect(analyticsCurveWindows(FROZEN_ON)).toEqual({
      current: { start: "2026-07-11", end: "2026-08-07" },
      previous: { start: "2026-06-13", end: "2026-07-10" },
      sustainability: { start: "2026-06-27", end: "2026-08-07" },
    });
    const first = await begin();
    const second = await begin();
    expect(first.inserted).toBe(true);
    expect(second).toEqual({ ...first, inserted: false });
    expect(first.generation.generationId).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.isFrozen(first.generation)).toBe(true);
    expect(Object.isFrozen(first.generation.windows.current)).toBe(true);
  });

  it("records exactly four immutable parts and promotes only the complete generation", async () => {
    const { generation } = await begin();
    const firstPart = ANALYTICS_CURVE_PARTS[0]!;
    const archiveAddress = "1".padStart(64, "0");
    const first = await repository.recordEvidence({
      generationId: generation.generationId,
      ...firstPart,
      archiveAddress,
      archiveRelPath: `2026/08/${archiveAddress}.json.gz`,
      archiveEpochSeconds: FROZEN_EPOCH_SECONDS,
      decodedBytes: 100,
    });
    await expect(repository.recordEvidence({
      generationId: generation.generationId,
      ...firstPart,
      archiveAddress,
      archiveRelPath: `2026/08/${archiveAddress}.json.gz`,
      archiveEpochSeconds: FROZEN_EPOCH_SECONDS,
      decodedBytes: 100,
    })).resolves.toEqual({ ...first, inserted: false });
    await expect(repository.promoteGeneration({
      generationId: generation.generationId,
      promotedEpochSeconds: FROZEN_EPOCH_SECONDS + 1,
    })).rejects.toThrow("analytics curve generation is incomplete");

    for (const [index, part] of ANALYTICS_CURVE_PARTS.slice(1).entries()) {
      const address = (index + 2).toString(16).padStart(64, "0");
      await repository.recordEvidence({
        generationId: generation.generationId,
        ...part,
        archiveAddress: address,
        archiveRelPath: `2026/08/${address}.json.gz`,
        archiveEpochSeconds: FROZEN_EPOCH_SECONDS,
        decodedBytes: 101 + index,
      });
    }
    await expect(repository.promoteGeneration({
      generationId: generation.generationId,
      promotedEpochSeconds: FROZEN_EPOCH_SECONDS + 1,
    })).resolves.toBe("promoted");
    await expect(repository.promoteGeneration({
      generationId: generation.generationId,
      promotedEpochSeconds: FROZEN_EPOCH_SECONDS + 1,
    })).resolves.toBe("already-current");

    const state = await repository.readState();
    expect(state.current?.generation).toEqual(generation);
    expect(state.current?.evidence).toHaveLength(4);
    expect(new Set(state.current?.evidence.map((row) => row.requestIdentity)).size).toBe(4);
    expect(state.refreshFailure).toBeNull();
    expect(Object.isFrozen(state.current?.evidence)).toBe(true);
  });

  it("preserves last-good state across a failed partial refresh and clears failure on promotion", async () => {
    const first = (await begin(FROZEN_ON, 11)).generation;
    await recordAll(first.generationId, 0, first.frozenEpochSeconds);
    await repository.promoteGeneration({
      generationId: first.generationId,
      promotedEpochSeconds: FROZEN_EPOCH_SECONDS,
    });

    const second = (await begin(FROZEN_ON, 13)).generation;
    const part = ANALYTICS_CURVE_PARTS[0]!;
    const archiveAddress = "f".repeat(64);
    await repository.recordEvidence({
      generationId: second.generationId,
      ...part,
      archiveAddress,
      archiveRelPath: `2026/08/${archiveAddress}.json.gz`,
      archiveEpochSeconds: second.frozenEpochSeconds,
      decodedBytes: 200,
    });
    await repository.recordRefreshFailure({
      generationId: second.generationId,
      code: "timeout",
      failedEpochSeconds: second.frozenEpochSeconds + 10,
    });
    const stale = await repository.readState();
    expect(stale.current?.generation.generationId).toBe(first.generationId);
    expect(stale.refreshFailure).toEqual({
      generationId: second.generationId,
      code: "timeout",
      failedEpochSeconds: second.frozenEpochSeconds + 10,
    });

    for (const [index, nextPart] of ANALYTICS_CURVE_PARTS.slice(1).entries()) {
      const address = (index + 32).toString(16).padStart(64, "0");
      await repository.recordEvidence({
        generationId: second.generationId,
        ...nextPart,
        archiveAddress: address,
        archiveRelPath: `2026/08/${address}.json.gz`,
        archiveEpochSeconds: second.frozenEpochSeconds,
        decodedBytes: 201 + index,
      });
    }
    await repository.promoteGeneration({
      generationId: second.generationId,
      promotedEpochSeconds: second.frozenEpochSeconds + 20,
    });
    const refreshed = await repository.readState();
    expect(refreshed.current?.generation.generationId).toBe(second.generationId);
    expect(refreshed.refreshFailure).toBeNull();
  });

  it("rejects changed duplicate parts, unsafe paths, oversize payloads, and malformed dates", async () => {
    const { generation } = await begin();
    const part = ANALYTICS_CURVE_PARTS[0]!;
    const archiveAddress = "a".repeat(64);
    const valid = {
      generationId: generation.generationId,
      ...part,
      archiveAddress,
      archiveRelPath: `2026/08/${archiveAddress}.json.gz`,
      archiveEpochSeconds: FROZEN_EPOCH_SECONDS,
      decodedBytes: 100,
    } as const;
    await repository.recordEvidence(valid);
    await expect(repository.recordEvidence({ ...valid, decodedBytes: 101 }))
      .rejects.toThrow("analytics curve invariant mismatch");
    await expect(repository.recordEvidence({ ...valid, archiveRelPath: "/private/curve.json.gz" }))
      .rejects.toThrow(new TypeError("invalid analytics curve input"));
    await expect(repository.recordEvidence({ ...valid, decodedBytes: 2_097_153 }))
      .rejects.toThrow(new TypeError("invalid analytics curve input"));
    await expect(repository.recordEvidence({
      ...valid,
      archiveEpochSeconds: FROZEN_EPOCH_SECONDS + 1,
    })).rejects.toThrow(new TypeError("invalid analytics curve input"));
    await expect(repository.recordRefreshFailure({
      generationId: generation.generationId,
      code: "timeout",
      failedEpochSeconds: FROZEN_EPOCH_SECONDS - 1,
    })).rejects.toThrow(new TypeError("invalid analytics curve input"));
    await expect(repository.beginGeneration({
      frozenEpochSeconds: FROZEN_EPOCH_SECONDS,
      frozenOn: "2026-02-30",
    })).rejects.toThrow(new TypeError("invalid analytics curve input"));
    const read = vi.fn(() => FROZEN_EPOCH_SECONDS);
    const accessorInput = { frozenOn: FROZEN_ON } as Record<string, unknown>;
    Object.defineProperty(accessorInput, "frozenEpochSeconds", { enumerable: true, get: read });
    await expect(repository.beginGeneration(accessorInput as never))
      .rejects.toThrow(new TypeError("invalid analytics curve input"));
    expect(read).not.toHaveBeenCalled();
  });

  it("enforces completeness and append-only evidence in SQLite itself", async () => {
    const { generation } = await begin();
    await expect(store.run(
      "INSERT INTO analytics_curve_generation_promotion(generation_id,promoted_epoch_s) VALUES(?,?)",
      [generation.generationId, FROZEN_EPOCH_SECONDS],
    )).rejects.toThrow();
    await recordAll(generation.generationId);
    await expect(store.run(
      "INSERT INTO analytics_curve_generation_promotion(generation_id,promoted_epoch_s) VALUES(?,?)",
      [generation.generationId, FROZEN_EPOCH_SECONDS - 1],
    )).rejects.toThrow();
    await repository.promoteGeneration({
      generationId: generation.generationId,
      promotedEpochSeconds: FROZEN_EPOCH_SECONDS,
    });
    await expect(store.run("DELETE FROM analytics_curve_evidence")).rejects.toThrow();
    await expect(store.run(
      "UPDATE analytics_curve_generation SET frozen_on='2026-08-08'",
    )).rejects.toThrow();
    await expect(store.run("DELETE FROM analytics_curve_current")).rejects.toThrow();
    expect(await store.all("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("rejects structurally valid rows whose content-derived identity was forged", async () => {
    const windows = analyticsCurveWindows(FROZEN_ON);
    const forgedGenerationId = "d".repeat(64);
    await store.run(`INSERT INTO analytics_curve_generation (
  generation_id,source,lane,frozen_epoch_s,frozen_on,current_start,current_end,
  previous_start,previous_end,sustainability_start,sustainability_end
) VALUES(?,?,?,?,?,?,?,?,?,?,?)`, [
      forgedGenerationId,
      "intervals-icu",
      "analytics-curves",
      FROZEN_EPOCH_SECONDS,
      FROZEN_ON,
      windows.current.start,
      windows.current.end,
      windows.previous.start,
      windows.previous.end,
      windows.sustainability.start,
      windows.sustainability.end,
    ]);
    await expect(repository.recordRefreshFailure({
      generationId: forgedGenerationId,
      code: "timeout",
      failedEpochSeconds: FROZEN_EPOCH_SECONDS,
    })).rejects.toThrow("analytics curve invariant mismatch");
    await store.run(`INSERT INTO analytics_curve_refresh_failure (
  singleton,generation_id,code,failed_epoch_s
) VALUES(1,?,?,?)`, [forgedGenerationId, "timeout", FROZEN_EPOCH_SECONDS]);
    await expect(repository.readState()).rejects.toThrow("analytics curve invariant mismatch");
  });
});
