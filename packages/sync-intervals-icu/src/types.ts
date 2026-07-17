import type { ArchiveManager } from "@enduragent/kernel/archive";
import type { PlatformImportArtifact } from "@enduragent/kernel/ingest";
import type { ClockPort, HttpPort } from "@enduragent/kernel/ports";
import type {
  AnchorHistoryRow,
  WellnessLandingRow,
  ZoneSetHistoryRow,
} from "@enduragent/kernel/store";
import type {
  RawFileSourceArtifact,
  SnapshotSourceArtifact,
  SourceCheckpoint,
  SourceWatermark,
  SyncBudget,
  SyncSource,
} from "@enduragent/kernel/store";

export const INTERVALS_ICU_SOURCE_ID = "intervals-icu" as const;
export const INTERVALS_ICU_CAPABILITIES = Object.freeze({
  activities: true,
  streams: true,
  rawFiles: true,
  wellness: true,
  plannedWorkoutPush: false,
  backfillDepth: Object.freeze({ kind: "full-history" as const }),
});

export const MAX_JSON_BYTES = 67_108_864;

export interface IntervalsLandingAcl {
  activity(row: Record<string, unknown>): Readonly<Record<string, unknown>>;
  wellness(row: Record<string, unknown>): Readonly<Record<string, unknown>>;
  streams(value: unknown): Readonly<Record<string, unknown>>;
  assertClean(value: unknown): void;
}

export interface IntervalsIcuSourceOptions {
  readonly athleteId: string;
  readonly historyNewestDate: string;
  readonly historyOldestDate?: string;
  readonly minRequestIntervalMs: number;
  readonly httpFactory: (args: {
    readonly outer: AbortSignal;
    readonly perRequestTimeoutMs: number;
  }) => HttpPort;
  readonly archive: ArchiveManager;
  readonly acl: IntervalsLandingAcl;
  readonly wallClock: Pick<ClockPort, "now">;
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
}

export type IntervalsIcuArtifact =
  | (SnapshotSourceArtifact & {
      readonly source: "intervals-icu";
      readonly landing:
        | { readonly kind: "activity"; readonly platform: PlatformImportArtifact }
        | { readonly kind: "streams"; readonly sourceRecordExternalId: string; readonly normalizedPayloadJson: string }
        | { readonly kind: "wellness"; readonly row: WellnessLandingRow }
        | { readonly kind: "settings"; readonly sourceRecordExternalId: string; readonly normalizedPayloadJson: string; readonly anchors: readonly AnchorHistoryRow[]; readonly zones: readonly ZoneSetHistoryRow[] };
    })
  | (RawFileSourceArtifact & {
      readonly kind: "raw-file";
      readonly source: "intervals-icu";
      readonly lane: "bulk-fit";
      readonly externalId: string;
      readonly container: {
        readonly externalId: string;
        readonly archiveInstant: { readonly epochSeconds: number };
        readonly archive: { readonly address: string; readonly relPath: string; readonly deduped: boolean };
      } | null;
    })
  | SourceCheckpoint;

export interface IntervalsIcuSource extends SyncSource {
  readonly id: "intervals-icu";
  readonly capabilities: typeof INTERVALS_ICU_CAPABILITIES;
  pull(watermark: SourceWatermark, budget: SyncBudget): AsyncIterable<IntervalsIcuArtifact>;
}
