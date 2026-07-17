import type { ArchiveInstant, ArchiveWriteResult } from "../archive/types.js";
import type { ImportArtifact } from "../ingest/import-report.js";
import type { ClockPort } from "../ports/clock.js";

export const SOURCE_IDS = ["intervals-icu", "file-import"] as const;
export type SourceId = (typeof SOURCE_IDS)[number];

export const SOURCE_LANES = [
  "activities",
  "streams",
  "wellness",
  "settings",
  "bulk-fit",
  "file-discovery",
] as const;
export type SourceLane = (typeof SOURCE_LANES)[number];

export type BackfillDepth =
  | { readonly kind: "none" }
  | { readonly kind: "bounded"; readonly days: number }
  | { readonly kind: "full-history" };

export interface SourceCapabilities {
  readonly activities: boolean;
  readonly streams: boolean;
  readonly rawFiles: boolean;
  readonly wellness: boolean;
  readonly plannedWorkoutPush: boolean;
  readonly backfillDepth: BackfillDepth;
}

export interface SourceWatermark {
  readonly source: SourceId;
  readonly lane: SourceLane;
  readonly value: string | null;
}

export interface SyncBudget {
  readonly signal: AbortSignal;
  readonly clock: Pick<ClockPort, "monotonicNow">;
  readonly deadlineMonotonicMs: number;
  readonly perRequestTimeoutMs: number;
  readonly maxRequests: number;
  readonly maxArtifacts: number;
}

export interface SnapshotSourceArtifact {
  readonly kind: "snapshot";
  readonly source: SourceId;
  readonly lane: "activities" | "streams" | "wellness" | "settings";
  readonly externalId: string;
  readonly archiveInstant: ArchiveInstant;
  readonly archive: ArchiveWriteResult;
  readonly payload: unknown;
}

export interface RawFileSourceArtifact {
  readonly kind: "raw-file";
  readonly source: SourceId;
  readonly lane: "bulk-fit" | "file-discovery";
  readonly externalId: string | null;
  readonly archiveInstant: ArchiveInstant;
  readonly archive: ArchiveWriteResult;
  readonly file: ImportArtifact;
}

export interface SourceCheckpoint {
  readonly kind: "checkpoint";
  readonly watermark: SourceWatermark;
}

export type SourceArtifact = SnapshotSourceArtifact | RawFileSourceArtifact | SourceCheckpoint;

export interface PlannedWorkoutDoc {
  readonly idempotencyKey: string;
  readonly dateKey: number;
  readonly sport: "cycling" | "running" | "swimming" | "duathlon" | "triathlon";
  readonly structure: Readonly<Record<string, unknown>>;
}

export type PushResult =
  | { readonly outcome: "created"; readonly externalId: string }
  | { readonly outcome: "updated"; readonly externalId: string }
  | { readonly outcome: "unchanged"; readonly externalId: string };

export interface SyncCompletion {
  readonly source: SourceId;
  readonly lane: SourceLane;
  readonly watermarkBefore: string | null;
  readonly watermarkAfter: string | null;
  readonly artifactsSeen: number;
  readonly sourceChanges: number;
}

export interface SyncCompletionResult {
  readonly operationId: number;
  readonly completionKind: "applied" | "no-op";
}

export interface SyncStateRepository {
  readWatermark(source: SourceId, lane: SourceLane): Promise<SourceWatermark>;
  recordCompletionInTransaction(input: SyncCompletion): Promise<SyncCompletionResult>;
}

export interface SyncSource {
  readonly id: SourceId;
  readonly capabilities: SourceCapabilities;
  pull(watermark: SourceWatermark, budget: SyncBudget): AsyncIterable<SourceArtifact>;
  pushPlannedWorkout?(doc: PlannedWorkoutDoc): Promise<PushResult>;
}
