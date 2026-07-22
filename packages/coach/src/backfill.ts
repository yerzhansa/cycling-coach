import { createHash } from "node:crypto";
import { setTimeout as setTimeoutPromise } from "node:timers/promises";
import {
  makeIntervalsHttpFactory,
} from "@enduragent/core";
import {
  assertNoTpKeysRemain,
  normalizeStreams,
  parseRenamedActivity,
  parseRenamedWellnessRow,
  renameTpFieldsOnActivity,
  renameTpFieldsOnWellnessRow,
} from "@enduragent/kernel/reference/local-bundle";
import type { ArchiveInstant, ArchiveManager, ArchiveWriteResult } from "@enduragent/kernel/archive";
import type { ImportArtifact, ImportReport, ImportReportDeps, PairDiagnostic, PlatformImportArtifact } from "@enduragent/kernel/ingest";
import { createSyncStateRepository, dumpStore, type PhysicalRequestLedger, type SourceArtifactDraft, type SqlStore, type SyncBudget } from "@enduragent/kernel/store";
import { createNodeImportRuntime, type NodeImportRuntime } from "@enduragent/kernel-node/ingest";
import type { AthleteHome } from "@enduragent/kernel-node/home";
import { openReadonlySqliteStorage } from "@enduragent/kernel-node/sqlite";
import {
  createIntervalsIcuSource,
  REQUEST_ATTEMPTS,
  type IntervalsIcuArtifact,
  type IntervalsIcuSource,
  type IntervalsLandingAcl,
} from "@enduragent/sync-intervals-icu";
import { withCoachStoreWriter } from "./runtime.js";

export const DEFAULT_BACKFILL_BATCH_SIZE = 400;
export const DEFAULT_REQUEST_INTERVAL_MS = 250;
export const DEFAULT_PER_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_BACKFILL_PAGE_DEADLINE_MS = 21_600_000;

export interface BackfillClock { now(): number; monotonicNow(): number; }

export interface StoreOwnerCheckOptions {
  readonly apiKey: string;
  readonly athleteId: string;
  readonly historyNewestDate: string;
  readonly clock: BackfillClock;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly signal?: AbortSignal;
  readonly baseFetch?: typeof globalThis.fetch;
  readonly budget?: SyncBudget;
  readonly attemptLedger?: PhysicalRequestLedger;
}

export type StoreOwnerCheckResult =
  | "unowned"
  | "matched"
  | "mismatch"
  | "unresolved"
  | "store-unavailable";

const lookupArchiveResult: ArchiveWriteResult = Object.freeze({
  address: "0".repeat(64),
  relPath: "1970/01/lookup.json.gz",
  deduped: true,
});

const lookupArchive: ArchiveManager = Object.freeze({
  async writeArtifact() { return lookupArchiveResult; },
  async writeSnapshot() { return lookupArchiveResult; },
  async quarantine() { return lookupArchiveResult; },
  async readArtifact() { throw new Error("lookup archive is write-only"); },
  async readSnapshot() { throw new Error("lookup archive is write-only"); },
  async has() { return false; },
});

const CLAIM_STORE_OWNER_SQL =
  "INSERT INTO store_owner (singleton, account_fingerprint) VALUES (1, ?)";
const STORE_OWNER_CHECK_BUSY_TIMEOUT_MS = 5_000;

async function readStoreOwnerFingerprint(
  store: Pick<SqlStore, "get">,
): Promise<string | undefined> {
  const current = await store.get(
    "SELECT account_fingerprint FROM store_owner WHERE singleton = 1",
  );
  if (current === undefined) return undefined;
  if (
    Object.keys(current).join(",") !== "account_fingerprint" ||
    typeof current.account_fingerprint !== "string" ||
    !/^[0-9a-f]{64}$/.test(current.account_fingerprint)
  ) {
    throw new Error("invalid store owner row");
  }
  return current.account_fingerprint;
}

async function compareStoreOwner(
  store: Pick<SqlStore, "get">,
  accountFingerprint: string,
): Promise<Extract<StoreOwnerCheckResult, "unowned" | "matched" | "mismatch">> {
  if (!/^[0-9a-f]{64}$/.test(accountFingerprint)) {
    throw new TypeError("invalid store owner fingerprint");
  }
  const current = await readStoreOwnerFingerprint(store);
  if (current === undefined) return "unowned";
  return current === accountFingerprint ? "matched" : "mismatch";
}

export async function resolveIntervalsStoreOwnerFingerprint(
  options: StoreOwnerCheckOptions,
): Promise<string | null> {
  const controller = new AbortController();
  const budget = options.budget ?? {
    signal: options.signal ?? controller.signal,
    clock: { monotonicNow: () => options.clock.monotonicNow() },
    deadlineMonotonicMs: options.clock.monotonicNow() + 300_000,
    perRequestTimeoutMs: DEFAULT_PER_REQUEST_TIMEOUT_MS,
    maxRequests: REQUEST_ATTEMPTS,
    maxArtifacts: 1_000,
  };
  const source = createIntervalsBackfillSource({
    apiKey: options.apiKey,
    athleteId: options.athleteId,
    historyNewestDate: options.historyNewestDate,
    minRequestIntervalMs: DEFAULT_REQUEST_INTERVAL_MS,
    archive: lookupArchive,
    clock: options.clock,
    sleep: options.sleep ?? sleepAbortably,
    ...(options.baseFetch === undefined ? {} : { baseFetch: options.baseFetch }),
    ...(options.attemptLedger === undefined ? {} : { attemptLedger: options.attemptLedger }),
  });
  const resolved = new Set<string>();
  for await (const artifact of source.pull(
    { source: "intervals-icu", lane: "settings", value: null },
    budget,
  )) {
    if (artifact.kind !== "snapshot" || artifact.lane !== "settings") continue;
    const payload = artifact.payload;
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
    const value = (payload as Record<string, unknown>).athlete_id;
    if (typeof value !== "string" || value.length === 0) return null;
    resolved.add(value);
  }
  if (resolved.size !== 1) return null;
  return createHash("sha256")
    .update(JSON.stringify(["store-owner-v1", [...resolved][0]]))
    .digest("hex");
}

async function enforceIntervalsStoreOwner(
  store: SqlStore,
  options: StoreOwnerCheckOptions,
  resolveFingerprint: (
    options: StoreOwnerCheckOptions,
  ) => Promise<string | null> = resolveIntervalsStoreOwnerFingerprint,
): Promise<"adopted" | "matched" | "unresolved"> {
  let fingerprint: string | null;
  try {
    fingerprint = await resolveFingerprint(options);
  } catch {
    return "unresolved";
  }
  if (fingerprint === null) return "unresolved";
  const ownership = await compareStoreOwner(store, fingerprint);
  if (ownership === "mismatch") throw new Error("training account mismatch");
  if (ownership === "matched") return "matched";
  await store.run(CLAIM_STORE_OWNER_SQL, [fingerprint]);
  return "adopted";
}

export async function checkIntervalsStoreOwnerAtPath(
  storePath: string,
  options: StoreOwnerCheckOptions,
): Promise<StoreOwnerCheckResult> {
  let store: ReturnType<typeof openReadonlySqliteStorage> | undefined;
  try {
    store = openReadonlySqliteStorage(storePath);
    const timeout = await store.get(`PRAGMA busy_timeout = ${STORE_OWNER_CHECK_BUSY_TIMEOUT_MS}`);
    if (timeout?.timeout !== STORE_OWNER_CHECK_BUSY_TIMEOUT_MS) {
      throw new Error("store owner check timeout unavailable");
    }
    if ((await readStoreOwnerFingerprint(store)) === undefined) {
      await store.close();
      return "unowned";
    }
  } catch {
    await store?.close().catch(() => undefined);
    return "store-unavailable";
  }
  let fingerprint: string | null;
  try {
    fingerprint = await resolveIntervalsStoreOwnerFingerprint(options);
  } catch {
    await store.close().catch(() => undefined);
    return "unresolved";
  }
  if (fingerprint === null) {
    await store.close().catch(() => undefined);
    return "unresolved";
  }
  try {
    const ownership = await compareStoreOwner(store, fingerprint);
    await store.close();
    return ownership;
  } catch {
    await store?.close().catch(() => undefined);
    return "store-unavailable";
  }
}

export function createIntervalsBackfillSource(options: {
  readonly apiKey: string;
  readonly athleteId: string;
  readonly historyNewestDate: string;
  readonly minRequestIntervalMs: number;
  readonly archive: ArchiveManager;
  readonly clock: BackfillClock;
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly baseFetch?: typeof globalThis.fetch;
  readonly attemptLedger?: PhysicalRequestLedger;
}): IntervalsIcuSource {
  const acl: IntervalsLandingAcl = Object.freeze({
    activity(row: Record<string, unknown>) {
      return parseRenamedActivity(renameTpFieldsOnActivity(row)) as unknown as Readonly<Record<string, unknown>>;
    },
    wellness(row: Record<string, unknown>) {
      return parseRenamedWellnessRow(renameTpFieldsOnWellnessRow(row)) as unknown as Readonly<Record<string, unknown>>;
    },
    streams(value: unknown) {
      const normalized = normalizeStreams(value);
      if (normalized === null || typeof normalized !== "object" || Array.isArray(normalized)) {
        throw new TypeError("invalid normalized streams");
      }
      return normalized as Readonly<Record<string, unknown>>;
    },
    assertClean: assertNoTpKeysRemain,
  });
  return createIntervalsIcuSource({
    athleteId: options.athleteId,
    historyNewestDate: options.historyNewestDate,
    historyOldestDate: "1900-01-01",
    minRequestIntervalMs: options.minRequestIntervalMs,
    httpFactory: makeIntervalsHttpFactory({
      apiKey: options.apiKey,
      ...(options.baseFetch === undefined ? {} : { baseFetch: options.baseFetch }),
    }),
    archive: options.archive,
    acl,
    wallClock: options.clock,
    sleep: options.sleep,
    ...(options.attemptLedger === undefined ? {} : { attemptLedger: options.attemptLedger }),
  });
}

function configured(value: unknown, fallback: number, minimum: number, maximum: number, name: string): number {
  const selected = value === undefined ? fallback : value;
  if (typeof selected !== "number" || !Number.isSafeInteger(selected) || selected < minimum || selected > maximum) {
    throw new TypeError(`invalid ${name}`);
  }
  return selected;
}

interface Cursor { readonly v: 1; readonly cycle: number; readonly window_start: string; readonly window_end: string;
  readonly last_key: string | null; readonly complete: boolean; }

function cursor(value: string | null): Cursor {
  if (value === null) throw new TypeError("source cursor is invalid");
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new TypeError("source cursor is invalid"); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)
    || Object.keys(parsed).join(",") !== "v,cycle,window_start,window_end,last_key,complete") throw new TypeError("source cursor is invalid");
  const item = parsed as Record<string, unknown>;
  if (item.v !== 1 || !Number.isSafeInteger(item.cycle) || (item.cycle as number) < 0
    || typeof item.window_start !== "string" || typeof item.window_end !== "string"
    || (item.last_key !== null && typeof item.last_key !== "string") || typeof item.complete !== "boolean"
    || JSON.stringify(item) !== value) throw new TypeError("source cursor is invalid");
  return item as unknown as Cursor;
}

function draft(externalId: string, archiveInstant: ArchiveInstant, archive: ArchiveWriteResult,
  lane: "activities" | "bulk-fit" = "bulk-fit"): SourceArtifactDraft {
  return { source: "intervals-icu", lane, externalId, artifactKind: lane === "activities" ? "snapshot" : "raw_file",
    archiveAddress: archive.address, archiveRelPath: archive.relPath, archiveEpochSeconds: archiveInstant.epochSeconds };
}

export interface RunBackfillPagesOptions {
  readonly store: SqlStore & { transaction<T>(work: () => Promise<T>): Promise<T> };
  readonly node: NodeImportRuntime;
  readonly source: IntervalsIcuSource;
  readonly clock: BackfillClock;
  readonly signal?: AbortSignal;
  readonly batchSize?: number;
  readonly perRequestTimeoutMs?: number;
  readonly backfillPageDeadlineMs?: number;
  readonly measurePhase?: ImportReportDeps["measurePhase"];
  readonly onPageCommitted?: (input: { readonly pages: number; readonly artifacts: number; readonly report: ImportReport | null }) => void;
}

export interface BackfillRunResult { readonly pages: number; readonly artifacts: number; readonly reports: readonly ImportReport[]; }

export async function runActivityAuditPages(options: RunBackfillPagesOptions): Promise<BackfillRunResult> {
  const batchSize = configured(options.batchSize, DEFAULT_BACKFILL_BATCH_SIZE, 1, 1_000, "batch size");
  const perRequestTimeoutMs = configured(options.perRequestTimeoutMs, DEFAULT_PER_REQUEST_TIMEOUT_MS, 1_000, 300_000, "request timeout");
  const pageDeadlineMs = configured(options.backfillPageDeadlineMs, DEFAULT_BACKFILL_PAGE_DEADLINE_MS, 60_000, 86_400_000, "page deadline");
  let pages = 0, artifacts = 0;
  const reports: ImportReport[] = [];
  for (;;) {
    const before = await createSyncStateRepository(options.store).readWatermark("intervals-icu", "activities");
    const controller = new AbortController();
    const abort = (): void => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) abort(); else options.signal?.addEventListener("abort", abort, { once: true });
    const budget: SyncBudget = { signal: controller.signal, clock: options.clock,
      deadlineMonotonicMs: options.clock.monotonicNow() + pageDeadlineMs, perRequestTimeoutMs,
      maxRequests: REQUEST_ATTEMPTS * (batchSize + 1), maxArtifacts: batchSize };
    const platformRecords: PlatformImportArtifact[] = [];
    let checkpoint: Extract<IntervalsIcuArtifact, { kind: "checkpoint" }> | null = null;
    try {
      for await (const artifact of options.source.pull(before, budget)) {
        if (checkpoint !== null) throw new Error("source item follows checkpoint");
        if (artifact.kind === "checkpoint") { checkpoint = artifact; continue; }
        if (artifact.kind !== "snapshot" || artifact.source !== "intervals-icu" || artifact.lane !== "activities"
          || artifact.landing.kind !== "activity" || typeof artifact.externalId !== "string" || artifact.externalId.length === 0) {
          throw new Error("invalid activities source artifact");
        }
        if (platformRecords.length >= batchSize) throw new Error("source exceeded page artifact budget");
        const evidence = draft(artifact.externalId, artifact.archiveInstant, artifact.archive, "activities");
        const platform = artifact.landing.platform;
        if (platform.sourceEvidence === undefined || platform.sourceEvidence.archive.address !== evidence.archiveAddress
          || platform.sourceEvidence.archive.relPath !== evidence.archiveRelPath
          || platform.sourceEvidence.externalId !== evidence.externalId) throw new Error("activity source evidence conflict");
        platformRecords.push(platform);
      }
    } finally { options.signal?.removeEventListener("abort", abort); }
    if (checkpoint === null || checkpoint.watermark.source !== "intervals-icu" || checkpoint.watermark.lane !== "activities") {
      throw new Error("invalid source checkpoint");
    }
    const checkpointValue = checkpoint.watermark.value;
    const parsed = cursor(checkpointValue);
    let report: ImportReport | null = null;
    if (platformRecords.length === 0) {
      await options.store.transaction(async () => {
        await createSyncStateRepository(options.store).recordCompletionInTransaction({ source: "intervals-icu", lane: "activities",
          watermarkBefore: before.value, watermarkAfter: checkpointValue, artifactsSeen: 0, sourceChanges: 0 });
      });
    } else {
      report = await options.node.importBatchWithReport({ files: [], platform_records: platformRecords }, {
        ...(options.measurePhase === undefined ? {} : { measurePhase: options.measurePhase }),
        finalizeBatchInTransaction: async (_store, result) => {
          const sourceChanges = result.source_artifact_inserted + result.raw_file_inserted
            + result.source_record_inserted + result.source_record_updated;
          await createSyncStateRepository(options.store).recordCompletionInTransaction({ source: "intervals-icu", lane: "activities",
            watermarkBefore: before.value, watermarkAfter: checkpointValue, artifactsSeen: platformRecords.length, sourceChanges });
        },
      });
      reports.push(report);
    }
    pages += 1; artifacts += platformRecords.length;
    options.onPageCommitted?.({ pages, artifacts, report });
    if (parsed.complete) break;
  }
  return Object.freeze({ pages, artifacts, reports: Object.freeze(reports) });
}

export async function runBackfillPages(options: RunBackfillPagesOptions): Promise<BackfillRunResult> {
  const batchSize = configured(options.batchSize, DEFAULT_BACKFILL_BATCH_SIZE, 1, 1_000, "batch size");
  const perRequestTimeoutMs = configured(options.perRequestTimeoutMs, DEFAULT_PER_REQUEST_TIMEOUT_MS, 1_000, 300_000, "request timeout");
  const pageDeadlineMs = configured(options.backfillPageDeadlineMs, DEFAULT_BACKFILL_PAGE_DEADLINE_MS, 60_000, 86_400_000, "page deadline");
  let pages = 0, artifacts = 0, terminalCursor: string | null = null;
  const reports: ImportReport[] = [];
  for (;;) {
    const before = await createSyncStateRepository(options.store).readWatermark("intervals-icu", "bulk-fit");
    const controller = new AbortController();
    const abort = (): void => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) abort(); else options.signal?.addEventListener("abort", abort, { once: true });
    const budget: SyncBudget = { signal: controller.signal, clock: options.clock,
      deadlineMonotonicMs: options.clock.monotonicNow() + pageDeadlineMs, perRequestTimeoutMs,
      maxRequests: REQUEST_ATTEMPTS * (batchSize + 1), maxArtifacts: batchSize };
    const files: ImportArtifact[] = [];
    let checkpoint: Extract<IntervalsIcuArtifact, { kind: "checkpoint" }> | null = null;
    try {
      for await (const artifact of options.source.pull(before, budget)) {
        if (checkpoint !== null) throw new Error("source item follows checkpoint");
        if (artifact.kind === "checkpoint") { checkpoint = artifact; continue; }
        if (artifact.source !== "intervals-icu" || artifact.lane !== "bulk-fit" || artifact.kind !== "raw-file"
          || typeof artifact.externalId !== "string" || artifact.externalId.length === 0 || artifact.file.ext !== "fit") {
          throw new Error("invalid bulk FIT source artifact");
        }
        if (files.length >= batchSize) throw new Error("source exceeded page artifact budget");
        const entry = draft(artifact.externalId, artifact.archiveInstant, artifact.archive);
        if (entry.archiveAddress !== artifact.file.source_evidence?.entry.archiveAddress && artifact.file.source_evidence !== undefined) {
          throw new Error("source evidence conflict");
        }
        files.push({ ...artifact.file, source_evidence: { container: artifact.container === null ? null
          : draft(artifact.container.externalId, artifact.container.archiveInstant, artifact.container.archive), entry } });
      }
    } finally {
      options.signal?.removeEventListener("abort", abort);
    }
    if (checkpoint === null || checkpoint.watermark.source !== "intervals-icu" || checkpoint.watermark.lane !== "bulk-fit") {
      throw new Error("invalid source checkpoint");
    }
    const checkpointValue = checkpoint.watermark.value;
    const parsed = cursor(checkpointValue);
    let report: ImportReport | null = null;
    if (files.length === 0) {
      await options.store.transaction(async () => {
        await createSyncStateRepository(options.store).recordCompletionInTransaction({ source: "intervals-icu", lane: "bulk-fit",
          watermarkBefore: before.value, watermarkAfter: checkpointValue, artifactsSeen: 0, sourceChanges: 0 });
      });
    } else {
      report = await options.node.importBatchWithReport({ files, platform_records: [] }, {
        ...(options.measurePhase === undefined ? {} : { measurePhase: options.measurePhase }),
        finalizeBatchInTransaction: async (_store, result) => {
          const sourceChanges = result.source_artifact_inserted + result.raw_file_inserted
            + result.source_record_inserted + result.source_record_updated;
          await createSyncStateRepository(options.store).recordCompletionInTransaction({ source: "intervals-icu", lane: "bulk-fit",
            watermarkBefore: before.value, watermarkAfter: checkpointValue, artifactsSeen: files.length, sourceChanges });
        },
      });
      reports.push(report);
    }
    pages += 1; artifacts += files.length;
    options.onPageCommitted?.({ pages, artifacts, report });
    if (terminalCursor !== null) {
      if (files.length !== 0 || checkpointValue !== terminalCursor) throw new Error("invalid terminal source replay");
      break;
    }
    if (parsed.complete) terminalCursor = checkpointValue;
  }
  return Object.freeze({ pages, artifacts, reports: Object.freeze(reports) });
}

export interface RunIntervalsBackfillOptions {
  readonly env: Record<string, string | undefined>;
  readonly apiKey: string;
  readonly athleteId: string;
  readonly historyNewestDate: string;
  readonly requestIntervalMs?: number;
  readonly batchSize?: number;
  readonly perRequestTimeoutMs?: number;
  readonly backfillPageDeadlineMs?: number;
  readonly signal?: AbortSignal;
  readonly clock?: BackfillClock;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly baseFetch?: typeof globalThis.fetch;
  readonly measurePhase?: ImportReportDeps["measurePhase"];
  readonly onPageCommitted?: RunBackfillPagesOptions["onPageCommitted"];
}

export interface RunIntervalsBackfillInWriterOptions
  extends Omit<RunIntervalsBackfillOptions, "env"> {
  readonly home: AthleteHome;
  readonly store: SqlStore & {
    transaction<T>(work: () => Promise<T>): Promise<T>;
  };
}

const productionClock: BackfillClock = Object.freeze({ now: () => Date.now(), monotonicNow: () => performance.now() });
const sleepAbortably = (ms: number, signal: AbortSignal): Promise<void> =>
  setTimeoutPromise(ms, undefined, { signal }).then(() => undefined);

export async function runIntervalsBackfillInWriter(
  options: RunIntervalsBackfillInWriterOptions,
): Promise<BackfillRunResult> {
  const requestIntervalMs = configured(options.requestIntervalMs, DEFAULT_REQUEST_INTERVAL_MS, 250, 60_000, "request interval");
  const clock = options.clock ?? productionClock, sleep = options.sleep ?? sleepAbortably;
  await enforceIntervalsStoreOwner(options.store, {
    apiKey: options.apiKey,
    athleteId: options.athleteId,
    historyNewestDate: options.historyNewestDate,
    clock,
    sleep,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.baseFetch === undefined ? {} : { baseFetch: options.baseFetch }),
  });
  const node = createNodeImportRuntime({ archiveDir: options.home.archiveDir, store: options.store });
  const source = createIntervalsBackfillSource({ apiKey: options.apiKey, athleteId: options.athleteId,
    historyNewestDate: options.historyNewestDate, minRequestIntervalMs: requestIntervalMs, archive: node.archive,
    clock, sleep, ...(options.baseFetch === undefined ? {} : { baseFetch: options.baseFetch }) });
  return runBackfillPages({ store: options.store, node, source, clock,
    ...(options.signal === undefined ? {} : { signal: options.signal }), ...(options.batchSize === undefined ? {} : { batchSize: options.batchSize }),
    ...(options.perRequestTimeoutMs === undefined ? {} : { perRequestTimeoutMs: options.perRequestTimeoutMs }),
    ...(options.backfillPageDeadlineMs === undefined ? {} : { backfillPageDeadlineMs: options.backfillPageDeadlineMs }),
    ...(options.measurePhase === undefined ? {} : { measurePhase: options.measurePhase }),
    ...(options.onPageCommitted === undefined ? {} : { onPageCommitted: options.onPageCommitted }) });
}

export function runIntervalsBackfill(options: RunIntervalsBackfillOptions): Promise<BackfillRunResult> {
  const { env, ...inWriterOptions } = options;
  return withCoachStoreWriter(env, ({ home, store }) => {
    return runIntervalsBackfillInWriter({ ...inWriterOptions, home, store });
  });
}

export interface DualPresentationAuditResult {
  readonly activities: BackfillRunResult;
  readonly bulkFit: BackfillRunResult;
  readonly rerunReports: readonly ImportReport[];
  readonly rerunRawFileInserts: number;
  readonly rerunSourceRecordInserts: number;
  readonly dumpBytesStable: boolean;
  readonly thresholdNearMisses: readonly PairDiagnostic[];
}

export function runIntervalsDualPresentationAudit(options: RunIntervalsBackfillOptions): Promise<DualPresentationAuditResult> {
  const requestIntervalMs = configured(options.requestIntervalMs, DEFAULT_REQUEST_INTERVAL_MS, 250, 60_000, "request interval");
  const clock = options.clock ?? productionClock, sleep = options.sleep ?? sleepAbortably;
  return withCoachStoreWriter(options.env, async ({ home, store }) => {
    const node = createNodeImportRuntime({ archiveDir: home.archiveDir, store });
    const source = createIntervalsBackfillSource({ apiKey: options.apiKey, athleteId: options.athleteId,
      historyNewestDate: options.historyNewestDate, minRequestIntervalMs: requestIntervalMs, archive: node.archive,
      clock, sleep, ...(options.baseFetch === undefined ? {} : { baseFetch: options.baseFetch }) });
    const shared = { store, node, source, clock,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.batchSize === undefined ? {} : { batchSize: options.batchSize }),
      ...(options.perRequestTimeoutMs === undefined ? {} : { perRequestTimeoutMs: options.perRequestTimeoutMs }),
      ...(options.backfillPageDeadlineMs === undefined ? {} : { backfillPageDeadlineMs: options.backfillPageDeadlineMs }),
      ...(options.measurePhase === undefined ? {} : { measurePhase: options.measurePhase }),
      ...(options.onPageCommitted === undefined ? {} : { onPageCommitted: options.onPageCommitted }) };
    const activities = await runActivityAuditPages(shared);
    const bulkFit = await runBackfillPages(shared);
    const before = await dumpStore(store);
    const rows = await store.all("SELECT sha256,path FROM raw_file WHERE ext='fit' ORDER BY sha256 COLLATE BINARY ASC");
    const rerunReports: ImportReport[] = [];
    for (let offset = 0; offset < rows.length; offset += DEFAULT_BACKFILL_BATCH_SIZE) {
      const files: ImportArtifact[] = [];
      for (const row of rows.slice(offset, offset + DEFAULT_BACKFILL_BATCH_SIZE)) {
        if (typeof row.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(row.sha256)
          || typeof row.path !== "string" || row.path.length === 0) throw new Error("invalid persisted FIT archive row");
        files.push({ input_path: `archive:${row.sha256}.fit`, bytes: await node.archive.readArtifact(row.path), ext: "fit" });
      }
      rerunReports.push(await node.importBatchWithReport({ files, platform_records: [] },
        options.measurePhase === undefined ? undefined : { measurePhase: options.measurePhase }));
    }
    const after = await dumpStore(store);
    const rerunRawFileInserts = rerunReports.reduce((sum, report) => sum + report.inserts.raw_file, 0);
    const rerunSourceRecordInserts = rerunReports.reduce((sum, report) => sum + report.inserts.source_record, 0);
    const thresholdNearMisses = rerunReports.flatMap((report) => report.threshold_near_misses);
    return Object.freeze({ activities, bulkFit, rerunReports: Object.freeze(rerunReports), rerunRawFileInserts,
      rerunSourceRecordInserts, dumpBytesStable: before === after, thresholdNearMisses: Object.freeze(thresholdNearMisses) });
  });
}
