import { readFileSync } from "node:fs";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  createPhysicalRequestLedger,
  PhysicalRequestLimitError,
  SOURCE_IDS,
  SOURCE_LANES,
  type BackfillDepth,
  type PlannedWorkoutDoc,
  type PushResult,
  type RawFileSourceArtifact,
  type SnapshotSourceArtifact,
  type SourceArtifact,
  type SourceCapabilities,
  type SourceCheckpoint,
  type SourceId,
  type SourceLane,
  type SourceWatermark,
  type SyncBudget,
  type SyncCompletion,
  type SyncCompletionResult,
  type SyncSource,
  type SyncStateRepository,
} from "../src/store/index.js";

describe("sync source contract", () => {
  it("exports the closed sync source type surface", () => {
    expect(SOURCE_IDS).toEqual(["intervals-icu", "file-import"]);
    expect(SOURCE_LANES).toEqual([
      "activities",
      "streams",
      "wellness",
      "settings",
      "bulk-fit",
      "file-discovery",
    ]);

    expectTypeOf<SourceId>().toEqualTypeOf<"intervals-icu" | "file-import">();
    expectTypeOf<SourceLane>().toEqualTypeOf<
      "activities" | "streams" | "wellness" | "settings" | "bulk-fit" | "file-discovery"
    >();
    expectTypeOf<keyof SourceCapabilities>().toEqualTypeOf<
      "activities" | "streams" | "rawFiles" | "wellness" | "plannedWorkoutPush" | "backfillDepth"
    >();
    expectTypeOf<BackfillDepth>().toEqualTypeOf<
      | { readonly kind: "none" }
      | { readonly kind: "bounded"; readonly days: number }
      | { readonly kind: "full-history" }
    >();
    expectTypeOf<SourceWatermark>().toMatchTypeOf<{
      readonly source: SourceId;
      readonly lane: SourceLane;
      readonly value: string | null;
    }>();
    expectTypeOf<SyncBudget>().toMatchTypeOf<{
      readonly signal: AbortSignal;
      readonly clock: { monotonicNow(): number };
      readonly deadlineMonotonicMs: number;
      readonly perRequestTimeoutMs: number;
      readonly maxRequests: number;
      readonly maxArtifacts: number;
    }>();
    expectTypeOf<SourceArtifact>().toEqualTypeOf<
      SnapshotSourceArtifact | RawFileSourceArtifact | SourceCheckpoint
    >();
    expectTypeOf<PlannedWorkoutDoc>().toEqualTypeOf<{
      readonly idempotencyKey: string;
      readonly dateKey: number;
      readonly sport: "cycling" | "running" | "swimming" | "duathlon" | "triathlon";
      readonly structure: Readonly<Record<string, unknown>>;
    }>();
    expectTypeOf<PushResult>().toEqualTypeOf<
      | { readonly outcome: "created"; readonly externalId: string }
      | { readonly outcome: "updated"; readonly externalId: string }
      | { readonly outcome: "unchanged"; readonly externalId: string }
    >();
    expectTypeOf<SyncCompletion>().toMatchTypeOf<{
      readonly source: SourceId;
      readonly lane: SourceLane;
      readonly watermarkBefore: string | null;
      readonly watermarkAfter: string | null;
      readonly artifactsSeen: number;
      readonly sourceChanges: number;
    }>();
    expectTypeOf<SyncCompletionResult>().toEqualTypeOf<{
      readonly operationId: number;
      readonly completionKind: "applied" | "no-op";
    }>();
    expectTypeOf<SyncStateRepository["readWatermark"]>().toBeFunction();
    expectTypeOf<SyncStateRepository["recordCompletionInTransaction"]>().toBeFunction();
    expectTypeOf<SyncSource["pull"]>().toBeFunction();
    expectTypeOf<SyncSource["pushPlannedWorkout"]>().toEqualTypeOf<
      ((doc: PlannedWorkoutDoc) => Promise<PushResult>) | undefined
    >();

    const source = readFileSync(new URL("../src/store/sync-source.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/validator|collector|consumePlannedWorkout/);
  });
});

describe("physical request ledger", () => {
  it("accounts atomically at the exact 64/15/79 ceilings", () => {
    const ledger = createPhysicalRequestLedger({ storeLimit: 64, legacyLimit: 15, totalLimit: 79 });
    for (let index = 0; index < 64; index += 1) ledger.charge("store", "store:activities");
    for (let index = 0; index < 15; index += 1) ledger.charge("legacy", "legacy:reference");
    const before = ledger.snapshot();
    expect(before).toMatchObject({ storeRequests: 64, legacyRequests: 15, totalRequests: 79 });
    expect(Object.isFrozen(before)).toBe(true); expect(Object.isFrozen(before.byTag)).toBe(true);
    expect(() => ledger.charge("legacy", "legacy:reference")).toThrow(PhysicalRequestLimitError);
    expect(ledger.snapshot()).toEqual(before);
    expect(Object.values(before.byTag).reduce((sum, value) => sum + value, 0)).toBe(79);
  });

  it("rejects every non-exact limit vector and mismatched path/tag without mutation", () => {
    expect(() => createPhysicalRequestLedger({ storeLimit: 63, legacyLimit: 15, totalLimit: 79 } as never))
      .toThrowError(new TypeError("invalid physical request limits"));
    const ledger = createPhysicalRequestLedger({ storeLimit: 64, legacyLimit: 15, totalLimit: 79 });
    expect(() => ledger.charge("store", "legacy:reference")).toThrow(TypeError);
    expect(ledger.snapshot().totalRequests).toBe(0);
  });
});
