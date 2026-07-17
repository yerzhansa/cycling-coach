import type { ArchiveInstant, ArchiveManager } from "../archive/types.js";
import type { MigratorStore } from "../store/migrator.js";
import type { RawFileRow, SqlStore } from "../store/ports.js";
import type { CanonicalPickResult, Candidate, LogicalSessionGroup } from "./canonical-pick.js";
import type { DedupCandidateSummary, PairDiagnostic, OverlapDiagnostic, AppliedConfirmationReport } from "./dedup.js";
import type { PlatformImportArtifact } from "./source-ledger.js";
import type { BrickReport } from "./brick-adjacency.js";
import type { RepairFixerSettings } from "./repair/types.js";
import type { FIT_INGEST_VERSION } from "./types.js";

export interface ImportArtifact {
  readonly input_path: string;
  readonly bytes: Uint8Array;
  readonly ext: "fit" | "tcx" | "gpx";
}

export interface ImportBatch {
  readonly files: readonly ImportArtifact[];
  readonly platform_records: readonly PlatformImportArtifact[];
}

export interface StableQuarantine { readonly code: string; readonly message: string; }

export interface PreparedRepairEvent {
  readonly candidate_id: string;
  readonly channel: string;
  readonly fixer: string;
  readonly changed_count: number;
  readonly changed_indices_json: string;
  readonly params_json: string;
}

export interface PreparedFile {
  readonly expected_address: string;
  readonly archive_instant: ArchiveInstant;
  readonly raw_file: Omit<RawFileRow, "path">;
  readonly candidates: readonly Candidate[];
  readonly summaries: readonly DedupCandidateSummary[];
  readonly repair_events: readonly PreparedRepairEvent[];
}

export type PrepareFileResult =
  | { readonly outcome: "prepared"; readonly value: PreparedFile }
  | { readonly outcome: "quarantined"; readonly quarantine: StableQuarantine };

export interface PlannedLogicalSession {
  readonly session_seq: number;
  readonly group: LogicalSessionGroup;
  readonly pick: CanonicalPickResult;
  readonly repair_events: readonly PreparedRepairEvent[];
}

export interface PlannedCluster {
  readonly cluster_id: string;
  readonly workout_key: string;
  readonly sessions: readonly PlannedLogicalSession[];
}

export interface ImportReportDeps {
  readonly archive: ArchiveManager;
  readonly store: SqlStore & Pick<MigratorStore, "transaction">;
  readonly hashKey: (fields: readonly (string | number)[]) => Promise<string>;
  readonly prepareFile: (
    artifact: ImportArtifact,
    repairSettings: RepairFixerSettings,
  ) => Promise<PrepareFileResult>;
  readonly canonicalPick: (group: LogicalSessionGroup) => CanonicalPickResult;
  readonly materializeClusterInTransaction: (store: SqlStore, cluster: PlannedCluster) => Promise<void>;
  readonly ingestVersion: typeof FIT_INGEST_VERSION;
}

export interface FileReport {
  readonly input_path: string;
  readonly address: string;
  readonly ext: "fit" | "tcx" | "gpx";
  readonly archive_deduped: boolean;
  readonly raw_file_inserted: boolean;
  readonly outcome: "imported" | "quarantined";
  readonly quarantine: { readonly code: string; readonly message: string } | null;
}

export interface ClusterReport {
  readonly cluster_id: string;
  readonly workout_key: string;
  readonly members: readonly string[];
  readonly edge_tiers: readonly ("tier2" | "tier3" | "confirmation" | "brick")[];
  readonly canonical_sources: readonly {
    readonly concern: string;
    readonly candidate_id: string;
    readonly rank: 100 | 200 | 300 | 400;
  }[];
}

export interface OrphanReport {
  readonly id: string;
  readonly target_kind: string;
  readonly target_key: string;
  readonly reason: "unsupported_target_kind" | "target_missing_after_rekey" | "confirmation_member_missing";
}

export interface ImportReport {
  readonly schema_version: 1;
  readonly ingest_version: typeof FIT_INGEST_VERSION;
  readonly effective: {
    readonly tier3: {
      readonly startSeconds: 120;
      readonly durationPercent: 10;
      readonly distancePercent: 10;
      readonly containmentSlackSeconds: 120;
      readonly nearMissMultiplier: 2;
    };
    readonly transition_window_s: 900;
  };
  readonly files: readonly FileReport[];
  readonly inserts: { readonly raw_file: number; readonly source_record: number };
  readonly updates: { readonly source_record: 0; readonly relinked_source_records: number };
  readonly clusters: readonly ClusterReport[];
  readonly threshold_near_misses: readonly PairDiagnostic[];
  readonly overlap_watchlist: readonly OverlapDiagnostic[];
  readonly confirm_queue: readonly PairDiagnostic[];
  readonly applied_confirmations: readonly AppliedConfirmationReport[];
  readonly brick_groups: readonly BrickReport[];
  readonly orphaned_overlays: readonly OrphanReport[];
}

export function serializeImportReport(report: ImportReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
