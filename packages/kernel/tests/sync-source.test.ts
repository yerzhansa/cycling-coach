import { readFileSync } from "node:fs";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
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
