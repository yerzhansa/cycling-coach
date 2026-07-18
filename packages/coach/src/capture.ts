import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout as setTimeoutPromise } from "node:timers/promises";
import {
  REFERENCE_CAPTURE_STREAM_LIMIT,
  assertReferenceCaptureReplayable,
  serializeReferenceCaptureManifest,
  validateReferenceCaptureManifest,
  type RecordRef,
  type ReferenceCaptureManifest,
} from "@enduragent/kernel/reference/capture";
import { H, createIntervalsSourceRepository, type PhysicalRequestLedger, type SourceArtifactDraft, type SyncBudget } from "@enduragent/kernel/store";
import {
  loadReferenceCaptureSidecars,
  readVerifiedReferenceSnapshot,
  validateReferenceCaptureReview,
  writeReferenceCaptureSidecars,
  type AssertReferenceCaptureReplayable,
  type ReferenceCaptureReview,
} from "@enduragent/kernel-node/capture-manifest";
import { createNodeCrypto, createNodeImportRuntime } from "@enduragent/kernel-node/ingest";
import { REQUEST_ATTEMPTS, type IntervalsIcuCaptureSource, type ReferenceCaptureBatch } from "@enduragent/sync-intervals-icu";
import { createIntervalsBackfillSource, DEFAULT_PER_REQUEST_TIMEOUT_MS, DEFAULT_REQUEST_INTERVAL_MS } from "./backfill.js";
import { withCoachStoreWriter } from "./runtime.js";

export type ReferenceCaptureFailureCategory = "capture" | "persistence" | "validation";

export class ReferenceCaptureRunError extends Error {
  readonly category: ReferenceCaptureFailureCategory;
  constructor(category: ReferenceCaptureFailureCategory, options?: ErrorOptions) {
    super("Reference capture failed", options);
    this.name = "ReferenceCaptureRunError";
    this.category = category;
  }
}

class ReferenceCaptureValidationError extends Error {}

export interface RunReferenceCaptureOptions {
  readonly env: Record<string, string | undefined>;
  readonly apiKey: string;
  readonly athleteId: string;
  readonly reviewedOn: string;
  readonly reason: ReferenceCaptureReview["reason"];
  readonly replacesCaptureId?: string;
  readonly budget?: SyncBudget;
  readonly baseFetch?: typeof globalThis.fetch;
  readonly attemptLedger?: PhysicalRequestLedger;
}

export interface RunReferenceCaptureDependencies {
  readonly wallClock?: () => Date;
  readonly uuid?: () => string;
  readonly monotonicNow?: () => number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly writeSidecars?: typeof writeReferenceCaptureSidecars;
  readonly loadSidecars?: typeof loadReferenceCaptureSidecars;
}

function sourceArtifact(
  record: ReferenceCaptureBatch["records"][keyof ReferenceCaptureBatch["records"]][number],
): SourceArtifactDraft {
  const lane: SourceArtifactDraft["lane"] = record.landing.kind === "activity" ? "activities"
    : record.landing.kind === "settings" ? "settings"
    : record.landing.kind === "wellness" ? "wellness" : "streams";
  return {
    source: "intervals-icu" as const,
    lane,
    externalId: record.externalId,
    artifactKind: "snapshot" as const,
    archiveAddress: record.archive.address,
    archiveRelPath: record.archive.relPath,
    archiveEpochSeconds: record.archiveInstant.epochSeconds,
  };
}

function snapshot(value: { readonly archive: { readonly address: string; readonly relPath: string } }) {
  return { address: value.archive.address, rel_path: value.archive.relPath };
}

export async function runReferenceCapture(
  options: RunReferenceCaptureOptions,
  dependencies: RunReferenceCaptureDependencies = {},
): Promise<ReferenceCaptureManifest> {
  const now = (dependencies.wallClock ?? (() => new Date()))();
  const captureId = (dependencies.uuid ?? randomUUID)();
  const monotonicNow = dependencies.monotonicNow ?? (() => performance.now());
  const sleep = dependencies.sleep ?? ((ms: number, signal: AbortSignal) =>
    setTimeoutPromise(ms, undefined, { signal }).then(() => undefined));
  const controller = new AbortController();
  const budget: SyncBudget = options.budget ?? {
    signal: controller.signal,
    clock: { monotonicNow },
    deadlineMonotonicMs: monotonicNow() + 15 * 60 * 1_000,
    perRequestTimeoutMs: DEFAULT_PER_REQUEST_TIMEOUT_MS,
    maxRequests: REQUEST_ATTEMPTS * (3 + REFERENCE_CAPTURE_STREAM_LIMIT),
    maxArtifacts: 10_000,
  };
  let review: ReferenceCaptureReview;
  try {
    review = validateReferenceCaptureReview({ schema_version: 1, capture_id: captureId,
      reviewed_on: options.reviewedOn, replaces_capture_id: options.replacesCaptureId ?? null,
      reason: options.reason });
  } catch (error) {
    throw new ReferenceCaptureRunError("validation", { cause: error });
  }

  return withCoachStoreWriter(options.env, async ({ home, store }) => {
    const crypto = createNodeCrypto();
    const node = createNodeImportRuntime({ archiveDir: home.archiveDir, store });
    const source = createIntervalsBackfillSource({
      apiKey: options.apiKey,
      athleteId: options.athleteId,
      historyNewestDate: now.toISOString().slice(0, 10),
      minRequestIntervalMs: DEFAULT_REQUEST_INTERVAL_MS,
      archive: node.archive,
      clock: { now: () => now.getTime(), monotonicNow },
      sleep,
      ...(options.baseFetch === undefined ? {} : { baseFetch: options.baseFetch }),
      ...(options.attemptLedger === undefined ? {} : { attemptLedger: options.attemptLedger }),
    }) as IntervalsIcuCaptureSource;
    let batch: ReferenceCaptureBatch;
    try { batch = await source.captureReference(now, budget); }
    catch (error) { throw new ReferenceCaptureRunError("capture", { cause: error }); }

    const repository = createIntervalsSourceRepository(store, (fields) => {
      if (fields.length === 0) throw new TypeError("empty key tuple");
      return H(crypto, ...(fields as [string | number, ...(string | number)[]]));
    });
    const wellnessArtifactKeys = new Map<string, string>();
    try {
      if (batch.records.activities.length > 0) {
        await node.importBatchWithReport({ files: [],
          platform_records: batch.records.activities.map((record) => record.landing.platform) });
      }
      await store.transaction(async () => {
        for (const record of batch.records.settings) {
          const evidence = await repository.recordArtifact(sourceArtifact(record));
          await repository.recordGenericLanding({ externalId: record.landing.sourceRecordExternalId,
            artifactKey: evidence.artifactKey, archiveAddress: record.archive.address, endpoint: "settings",
            normalizedPayloadJson: record.landing.normalizedPayloadJson });
          for (const anchor of record.landing.anchors) await repository.insertSyncedAnchor(anchor);
          for (const zone of record.landing.zones) await repository.insertSyncedZone(zone);
        }
        for (const record of batch.records.wellness) {
          const evidence = await repository.recordArtifact(sourceArtifact(record));
          wellnessArtifactKeys.set(record.externalId, evidence.artifactKey);
          await repository.upsertWellness(record.landing.row);
        }
        for (const record of batch.records.streams) {
          const evidence = await repository.recordArtifact(sourceArtifact(record));
          await repository.recordGenericLanding({ externalId: record.landing.sourceRecordExternalId,
            artifactKey: evidence.artifactKey, archiveAddress: record.archive.address, endpoint: "streams",
            normalizedPayloadJson: record.landing.normalizedPayloadJson });
        }
      });
    } catch (error) {
      throw new ReferenceCaptureRunError("persistence", { cause: error });
    }

    const records = { settings: [] as RecordRef[], activities: [] as RecordRef[],
      wellness: [] as RecordRef[], streams: [] as RecordRef[] };
    try {
      for (const lane of ["settings", "activities", "wellness", "streams"] as const) {
        const sourceRecords = batch.records[lane];
        for (let ordinal = 0; ordinal < sourceRecords.length; ordinal += 1) {
          const record = sourceRecords[ordinal]!;
          if (lane === "wellness") {
            const artifactKey = wellnessArtifactKeys.get(record.externalId);
            if (artifactKey === undefined) throw new Error("wellness capture evidence is absent");
            records[lane].push({ ordinal, endpoint_ordinal: record.endpointOrdinal,
              payload_index: record.payloadIndex, external_id: record.externalId, snapshot: snapshot(record),
              store_evidence: { artifact_key: artifactKey, current_revision: null } });
          } else {
            const evidence = await repository.readCurrentCaptureEvidence(lane, record.externalId);
            if (evidence.archiveAddress !== record.archive.address || evidence.archiveRelPath !== record.archive.relPath) {
              throw new Error("current capture evidence disagrees with snapshot");
            }
            records[lane].push({ ordinal, endpoint_ordinal: record.endpointOrdinal,
              payload_index: record.payloadIndex, external_id: record.externalId, snapshot: snapshot(record),
              store_evidence: { artifact_key: evidence.artifactKey,
                current_revision: { source_record_id: evidence.sourceRecordId, revision_id: evidence.revisionId } } });
          }
        }
      }
    } catch (error) {
      throw new ReferenceCaptureRunError("persistence", { cause: error });
    }

    let manifest: ReferenceCaptureManifest;
    try {
      manifest = validateReferenceCaptureManifest({
        schema_version: 1,
        capture_id: captureId,
        source: "external-oracle",
        plan: batch.plan,
        operation_ledger: { link_kind: "capture-id", capture_id: captureId },
        endpoints: batch.endpoints.map((endpoint) => ({ ordinal: endpoint.ordinal, lane: endpoint.lane,
          endpoint: endpoint.endpoint, request: endpoint.request, snapshot: snapshot(endpoint) })),
        records,
        selected_stream_ids: [...batch.selected_stream_ids],
        captured_stream_ids: [...batch.captured_stream_ids],
        deterministic_order: {
          endpoint_ordinals: batch.endpoints.map((endpoint) => endpoint.ordinal),
          settings: batch.records.settings.map((record) => record.externalId),
          activities: batch.records.activities.map((record) => record.externalId),
          wellness: batch.records.wellness.map((record) => record.externalId),
          streams: [...batch.captured_stream_ids],
        },
      });
    } catch (error) {
      throw new ReferenceCaptureRunError("validation", { cause: error });
    }

    const assertReplayable: AssertReferenceCaptureReplayable = async (candidate) => {
      try {
        await assertReferenceCaptureReplayable(candidate, {
          readVerifiedSnapshot: (reference) => readVerifiedReferenceSnapshot(reference, { archive: node.archive, crypto }),
          derivePayloadMembers: (plan, endpointPayloads) => source.deriveReferenceCaptureMembers(plan, endpointPayloads),
          assertStoreEvidence: (record, lane) => repository.assertPinnedCaptureEvidence({ lane,
            externalId: record.external_id, artifactKey: record.store_evidence.artifact_key,
            archiveAddress: record.snapshot.address, archiveRelPath: record.snapshot.rel_path,
            currentRevision: record.store_evidence.current_revision === null ? null : {
              sourceRecordId: record.store_evidence.current_revision.source_record_id,
              revisionId: record.store_evidence.current_revision.revision_id,
            } }),
        });
      } catch (error) { throw new ReferenceCaptureValidationError("capture replay validation failed", { cause: error }); }
    };

    try {
      const committed = await (dependencies.writeSidecars ?? writeReferenceCaptureSidecars)({
        root: home.root, manifest, review, assertReplayable,
      });
      if (dependencies.loadSidecars !== undefined) {
        const loaded = await dependencies.loadSidecars({ root: home.root, captureId, assertReplayable });
        return loaded.manifest;
      }
      return committed.manifest;
    } catch (error) {
      throw new ReferenceCaptureRunError(error instanceof ReferenceCaptureValidationError ? "validation" : "persistence", { cause: error });
    }
  });
}

export function referenceCaptureEvidenceSha256Input(manifest: ReferenceCaptureManifest): Uint8Array {
  return new TextEncoder().encode(serializeReferenceCaptureManifest(manifest));
}
