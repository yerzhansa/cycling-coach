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

export type RefreshRequestTag =
  | "store:activities"
  | "store:analytics-curves"
  | "store:wellness"
  | "store:settings"
  | "store:streams"
  | "legacy:reference";

export interface PhysicalRequestCounts {
  readonly storeRequests: number;
  readonly legacyRequests: number;
  readonly totalRequests: number;
  readonly byTag: Readonly<Record<RefreshRequestTag, number>>;
}

export interface PhysicalRequestLedger {
  charge(path: "store" | "legacy", tag: RefreshRequestTag): void;
  tryReserve(
    path: "store" | "legacy",
    tag: RefreshRequestTag,
    count: number,
  ): PhysicalRequestReservation | null;
  snapshot(): PhysicalRequestCounts;
}

export interface PhysicalRequestReservation {
  /** Convert one held slot into one physical request charge. */
  charge(): void;
  /** Idempotently return every unused slot; callers should use this in finally. */
  release(): void;
  /** Number of held slots not yet charged or released. */
  remaining(): number;
}

export class PhysicalRequestLimitError extends Error {
  constructor(message = "shared physical request ceiling exceeded") {
    super(message);
    this.name = "PhysicalRequestLimitError";
  }
}

export class PhysicalRequestReservationSettledError extends Error {
  constructor() {
    super("physical request reservation is settled");
    this.name = "PhysicalRequestReservationSettledError";
  }
}

const REFRESH_REQUEST_TAGS = Object.freeze([
  "store:activities",
  "store:analytics-curves",
  "store:wellness",
  "store:settings",
  "store:streams",
  "legacy:reference",
] as const satisfies readonly RefreshRequestTag[]);

export function createPhysicalRequestLedger(input: {
  storeLimit: 64;
  legacyLimit: 15;
  totalLimit: 79;
}): PhysicalRequestLedger {
  if (
    input === null
    || typeof input !== "object"
    || input.storeLimit !== 64
    || input.legacyLimit !== 15
    || input.totalLimit !== 79
  ) {
    throw new TypeError("invalid physical request limits");
  }
  const limits = Object.freeze({
    store: input.storeLimit,
    legacy: input.legacyLimit,
    total: input.totalLimit,
  });
  const byTag: Record<RefreshRequestTag, number> = {
    "store:activities": 0,
    "store:analytics-curves": 0,
    "store:wellness": 0,
    "store:settings": 0,
    "store:streams": 0,
    "legacy:reference": 0,
  };
  let storeRequests = 0;
  let legacyRequests = 0;
  let totalRequests = 0;
  let reservedStoreRequests = 0;
  let reservedLegacyRequests = 0;
  let reservedTotalRequests = 0;

  const validateCharge = (path: "store" | "legacy", tag: RefreshRequestTag): void => {
    if (
      (path !== "store" && path !== "legacy")
      || !REFRESH_REQUEST_TAGS.includes(tag)
      || (path === "store" && !tag.startsWith("store:"))
      || (path === "legacy" && tag !== "legacy:reference")
    ) {
      throw new TypeError("invalid physical request charge");
    }
  };
  const hasCapacity = (path: "store" | "legacy", count: number): boolean => {
    const used = path === "store" ? storeRequests : legacyRequests;
    const reserved = path === "store" ? reservedStoreRequests : reservedLegacyRequests;
    return used + reserved + count <= limits[path]
      && totalRequests + reservedTotalRequests + count <= limits.total;
  };
  const recordCharge = (path: "store" | "legacy", tag: RefreshRequestTag): void => {
    if (path === "store") storeRequests += 1;
    else legacyRequests += 1;
    totalRequests += 1;
    byTag[tag] += 1;
  };
  const changeReserved = (path: "store" | "legacy", count: number): void => {
    if (path === "store") reservedStoreRequests += count;
    else reservedLegacyRequests += count;
    reservedTotalRequests += count;
  };

  return Object.freeze({
    charge(path: "store" | "legacy", tag: RefreshRequestTag): void {
      validateCharge(path, tag);
      if (!hasCapacity(path, 1)) throw new PhysicalRequestLimitError();
      recordCharge(path, tag);
    },
    tryReserve(
      path: "store" | "legacy",
      tag: RefreshRequestTag,
      count: number,
    ): PhysicalRequestReservation | null {
      validateCharge(path, tag);
      if (!Number.isSafeInteger(count) || count <= 0) {
        throw new TypeError("invalid physical request reservation");
      }
      if (!hasCapacity(path, count)) return null;
      changeReserved(path, count);
      let remaining = count;
      let settled = false;
      return Object.freeze({
        charge(): void {
          if (settled || remaining === 0) throw new PhysicalRequestReservationSettledError();
          changeReserved(path, -1);
          recordCharge(path, tag);
          remaining -= 1;
          if (remaining === 0) settled = true;
        },
        release(): void {
          if (settled) return;
          changeReserved(path, -remaining);
          remaining = 0;
          settled = true;
        },
        remaining(): number {
          return remaining;
        },
      });
    },
    snapshot(): PhysicalRequestCounts {
      return Object.freeze({
        storeRequests,
        legacyRequests,
        totalRequests,
        byTag: Object.freeze({ ...byTag }),
      });
    },
  });
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
