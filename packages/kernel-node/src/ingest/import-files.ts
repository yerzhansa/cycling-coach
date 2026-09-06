import { extname } from "node:path";
import { readFile } from "node:fs/promises";
import { createArchiveManager } from "../archive/manager.js";
import {
  FitSourceError,
  FIT_INGEST_VERSION,
  QUALITY_RANK,
  applyRepairFixerSettingWithRebuild,
  canonicalPick,
  createMaterializeClusterInTransaction,
  decodeStream,
  importArtifactsIncrementally,
  mapFitArtifact,
  type Candidate,
  type ConcernValue,
  type DedupCandidateSummary,
  type ImportArtifact,
  type ImportArtifactSource,
  type ImportReport,
  type ImportReportDeps,
  type LapConcern,
  type PrepareFileResult,
  type PreparedFile,
  type PreparedRepairEvent,
  type RepairFixer,
  type RepairFixerSettingChangeResult,
  type RepairFixerSettings,
  type SwimLengthConcern,
} from "@enduragent/kernel/ingest";
import type { ArchiveManager } from "@enduragent/kernel/archive";
import { H, sortKeys, type MigratorStore, type SqlStore } from "@enduragent/kernel/store";
import type { CryptoPort } from "@enduragent/kernel/ports";
import { nodeFileSystem } from "../filesystem/index.js";
import { createFitDecoder } from "./fit-decoder.js";
import { prepareXmlFile } from "./xml-file.js";

export interface ImportFilesOptions {
  readonly inputPaths: readonly string[];
  readonly archiveDir: string;
  readonly store: SqlStore & Pick<MigratorStore, "transaction">;
}

export interface NodeImportRuntimeOptions {
  readonly archiveDir: string;
  readonly store: SqlStore & Pick<MigratorStore, "transaction">;
}

export interface NodeImportRuntime {
  readonly archive: ArchiveManager;
  importBatchWithReport(
    batch: import("@enduragent/kernel/ingest").ImportBatch,
    hooks?: Pick<ImportReportDeps, "finalizeBatchInTransaction" | "measurePhase">,
  ): Promise<ImportReport>;
  importBatchWithPreparation(
    batch: import("@enduragent/kernel/ingest").ImportBatch,
    prepareFile: ImportReportDeps["prepareFile"],
    hooks?: Pick<ImportReportDeps, "finalizeBatchInTransaction" | "measurePhase">,
  ): Promise<ImportReport>;
}

export interface SetRepairFixerEnabledOptions {
  readonly fixer: RepairFixer;
  readonly enabled: boolean;
  readonly archiveDir: string;
  readonly store: SqlStore & Pick<MigratorStore, "transaction">;
}

export function createNodeCrypto(): CryptoPort {
  const subtle = globalThis.crypto.subtle;
  const toBufferSource = (view: Uint8Array): Uint8Array<ArrayBuffer> => {
    if (
      view.byteOffset === 0 &&
      view.byteLength === view.buffer.byteLength &&
      view.buffer instanceof ArrayBuffer
    ) {
      return view as Uint8Array<ArrayBuffer>;
    }
    const copy = new Uint8Array(view.length);
    copy.set(view);
    return copy;
  };
  const key = (bytes: Uint8Array, usage: "encrypt" | "decrypt") =>
    subtle.importKey("raw", toBufferSource(bytes), { name: "AES-GCM" }, false, [usage]);
  return {
    async sha256(data) {
      return new Uint8Array(await subtle.digest("SHA-256", toBufferSource(data)));
    },
    async randomBytes(length) {
      const value = new Uint8Array(length);
      globalThis.crypto.getRandomValues(value);
      return value;
    },
    async pbkdf2(params) {
      const material = await subtle.importKey(
        "raw",
        toBufferSource(params.passphrase),
        "PBKDF2",
        false,
        ["deriveBits"],
      );
      return new Uint8Array(
        await subtle.deriveBits(
          {
            name: "PBKDF2",
            hash: params.hash,
            salt: toBufferSource(params.salt),
            iterations: params.iterations,
          },
          material,
          params.keyLengthBytes * 8,
        ),
      );
    },
    async aesGcmEncrypt(params) {
      return new Uint8Array(
        await subtle.encrypt(
          {
            name: "AES-GCM",
            iv: toBufferSource(params.nonce),
            additionalData:
              params.additionalData === undefined
                ? undefined
                : toBufferSource(params.additionalData),
          },
          await key(params.key, "encrypt"),
          toBufferSource(params.plaintext),
        ),
      );
    },
    async aesGcmDecrypt(params) {
      return new Uint8Array(
        await subtle.decrypt(
          {
            name: "AES-GCM",
            iv: toBufferSource(params.nonce),
            additionalData:
              params.additionalData === undefined
                ? undefined
                : toBufferSource(params.additionalData),
          },
          await key(params.key, "decrypt"),
          toBufferSource(params.ciphertext),
        ),
      );
    },
  };
}

function canonical(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function concernsForSession(
  mapped: Awaited<ReturnType<typeof mapFitArtifact>>,
  sessionIndex: number,
): Readonly<Record<string, ConcernValue>> {
  const session = mapped.activity.sessions[sessionIndex]!;
  const concerns: Record<string, ConcernValue> = {
    "session.sport": session.sport,
    "session.start_utc": session.start_utc,
    "session.local_date_key": session.local_date_key,
    "session.is_transition": session.is_transition === 1,
  };
  const optionals = [
    ["session.sub_sport", session.sub_sport],
    ["session.tz_offset_s", session.tz_offset_s],
    ["session.elapsed_s", session.elapsed_s],
    ["session.timer_s", session.timer_s],
    ["session.moving_s", session.moving_s],
    ["session.distance_m", session.distance_m],
    ["session.summary_json", session.summary_json],
  ] as const;
  for (const [key, value] of optionals) if (value !== null) concerns[key] = value;
  const laps = mapped.activity.laps.filter((lap) => lap.session_key === session.session_key);
  if (laps.length > 0)
    concerns["lap[]"] = laps.map(
      (lap): LapConcern => ({
        lap_seq: lap.lap_seq,
        start_utc: lap.start_utc,
        elapsed_s: lap.elapsed_s,
        timer_s: lap.timer_s,
        distance_m: lap.distance_m,
        summary_json: lap.summary_json,
      }),
    );
  const lapSeqByKey = new Map(laps.map((lap) => [lap.lap_key, lap.lap_seq]));
  const lengths = mapped.activity.swimLengths.filter((length) => lapSeqByKey.has(length.lap_key));
  if (lengths.length > 0)
    concerns["swim_length[]"] = lengths.map(
      (length): SwimLengthConcern => ({
        lap_seq: lapSeqByKey.get(length.lap_key)!,
        length_seq: length.length_seq,
        start_utc: length.start_utc,
        elapsed_s: length.elapsed_s,
        timer_s: length.timer_s,
        distance_m: length.distance_m,
        strokes: length.strokes,
        stroke_type: length.stroke_type,
        length_type: length.length_type,
      }),
    );
  const streams = mapped.activity.streams.filter(
    (stream) => stream.session_key === session.session_key,
  );
  const time = streams.find((stream) => stream.channel === "time");
  if (time) {
    const timestamps = decodeStream({
      encoding: time.encoding,
      n: time.n,
      kind: "time",
      data: time.data,
    }) as readonly number[];
    for (const stream of streams) {
      const values = decodeStream({
        encoding: stream.encoding,
        n: stream.n,
        kind: stream.channel === "time" ? "time" : "value",
        data: stream.data,
      });
      concerns[`stream:${stream.channel}`] = { timestamps: [...timestamps], values: [...values] };
    }
  }
  return concerns;
}

async function prepareFit(
  artifact: ImportArtifact,
  crypto: CryptoPort,
  repairSettings: RepairFixerSettings,
): Promise<PrepareFileResult> {
  const digest = await crypto.sha256(artifact.bytes);
  const address = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  let mapped: Awaited<ReturnType<typeof mapFitArtifact>>;
  try {
    const decoded = await createFitDecoder().decode(artifact.bytes);
    mapped = await mapFitArtifact({
      crypto,
      rawSha256: address,
      rawByteLength: artifact.bytes.byteLength,
      archivePath: null,
      decoded,
      repairSettings,
    });
  } catch (error) {
    if (!(error instanceof FitSourceError)) throw error;
    return {
      outcome: "quarantined",
      quarantine: { code: `fit:${error.code}`, message: error.message },
    };
  }
  const candidates: Candidate[] = mapped.activity.sessions.map((session, index) => ({
    id: `fit:${address}:0:${index}`,
    origin: { kind: "file", format: "fit", rawSha256: address },
    workoutOrdinal: 0,
    sessionOrdinal: index,
    rank: QUALITY_RANK.FIT,
    concerns: concernsForSession(mapped, index),
  }));
  const summaries: DedupCandidateSummary[] = candidates.map((candidate, index) => {
    const session = mapped.activity.sessions[index]!,
      concerns = candidate.concerns;
    const time = concerns["stream:time"] as { readonly timestamps: readonly number[] } | undefined;
    const duration =
      session.elapsed_s ??
      (time ? time.timestamps[time.timestamps.length - 1]! - time.timestamps[0]! : null);
    if (duration === null) throw new FitSourceError("invalid_numeric");
    return {
      candidate_id: candidate.id,
      member_id: address,
      source_kind: "fit",
      source_session_seq: index,
      sport_family: session.sport,
      is_transition: session.is_transition === 1,
      start_utc: session.start_utc,
      duration_s: duration,
      distance_m: session.distance_m,
      file_id_manufacturer: mapped.rawFile.manufacturer,
      file_id_serial: mapped.rawFile.file_id_serial,
      file_id_time_created_utc: mapped.rawFile.file_id_time_created_utc,
    };
  });
  const candidateIdBySession = new Map(
    mapped.activity.sessions.map((session, index) => [session.session_key, candidates[index]!.id]),
  );
  const repairEvents: PreparedRepairEvent[] = mapped.activity.repairLogs.map((event) => ({
    candidate_id: candidateIdBySession.get(event.sessionKey)!,
    channel: event.channel,
    fixer: event.fixer,
    changed_count: event.changedIndices.length,
    changed_indices_json: JSON.stringify(event.changedIndices),
    params_json: canonical(event.params),
  }));
  const { path: _path, ...raw } = mapped.rawFile;
  const value: PreparedFile = {
    expected_address: address,
    archive_instant: { epochSeconds: Math.floor(mapped.logicalArchiveEpochSeconds) },
    raw_file: raw,
    candidates,
    summaries,
    repair_events: repairEvents,
  };
  return { outcome: "prepared", value };
}

async function prepareActivityArtifactWithCrypto(
  artifact: ImportArtifact,
  repairSettings: RepairFixerSettings,
  crypto: CryptoPort,
): Promise<PrepareFileResult> {
  return artifact.ext === "fit"
    ? prepareFit(artifact, crypto, repairSettings)
    : prepareXmlFile(artifact.bytes, artifact.ext, { crypto });
}

export function prepareActivityArtifact(
  artifact: ImportArtifact,
  repairSettings: RepairFixerSettings,
): Promise<PrepareFileResult> {
  return prepareActivityArtifactWithCrypto(artifact, repairSettings, createNodeCrypto());
}

function createImportReportDeps(options: NodeImportRuntimeOptions): ImportReportDeps {
  const crypto = createNodeCrypto();
  const fs = nodeFileSystem();
  const archive = createArchiveManager({ archiveRoot: options.archiveDir, crypto, fs });
  const hashKey = (fields: readonly (string | number)[]): Promise<string> => {
    if (fields.length === 0) throw new TypeError("empty key tuple");
    return H(crypto, ...(fields as [string | number, ...(string | number)[]]));
  };
  return {
    archive,
    store: options.store,
    hashKey,
    prepareFile: (artifact, repairSettings) =>
      prepareActivityArtifactWithCrypto(artifact, repairSettings, crypto),
    canonicalPick,
    materializeClusterInTransaction: createMaterializeClusterInTransaction(hashKey),
    ingestVersion: FIT_INGEST_VERSION,
  };
}

export async function importFilesWithReport(options: ImportFilesOptions): Promise<ImportReport> {
  if (options.inputPaths.length === 0) throw new TypeError("input path list is empty");
  const seen = new Set<string>();
  const files: ImportArtifactSource[] = [];
  for (const inputPath of options.inputPaths) {
    if (typeof inputPath !== "string" || inputPath.length === 0 || seen.has(inputPath))
      throw new TypeError("duplicate or invalid input path");
    seen.add(inputPath);
    const ext = extname(inputPath).slice(1).toLowerCase();
    if (ext !== "fit" && ext !== "tcx" && ext !== "gpx")
      throw new TypeError("unsupported input extension");
    files.push({ input_path: inputPath, readBytes: () => readFile(inputPath), ext });
  }
  return createNodeImportRuntime(options).importBatchWithReport({ files, platform_records: [] });
}

export function createNodeImportRuntime(options: NodeImportRuntimeOptions): NodeImportRuntime {
  if (
    options === null ||
    typeof options !== "object" ||
    typeof options.archiveDir !== "string" ||
    options.archiveDir.length === 0 ||
    options.store === null ||
    typeof options.store !== "object" ||
    typeof options.store.exec !== "function" ||
    typeof options.store.run !== "function" ||
    typeof options.store.get !== "function" ||
    typeof options.store.all !== "function" ||
    typeof options.store.close !== "function" ||
    typeof options.store.transaction !== "function"
  ) {
    throw new TypeError("invalid node import runtime options");
  }
  const deps = createImportReportDeps(options);
  const importWith = (
    batch: import("@enduragent/kernel/ingest").ImportBatch,
    prepareFile: ImportReportDeps["prepareFile"],
    hooks?: Pick<ImportReportDeps, "finalizeBatchInTransaction" | "measurePhase">,
  ): Promise<ImportReport> =>
    importArtifactsIncrementally(batch, {
      ...deps,
      prepareFile,
      ...(hooks?.finalizeBatchInTransaction === undefined
        ? {}
        : { finalizeBatchInTransaction: hooks.finalizeBatchInTransaction }),
      ...(hooks?.measurePhase === undefined ? {} : { measurePhase: hooks.measurePhase }),
    });
  return Object.freeze({
    archive: deps.archive,
    importBatchWithReport(
      batch: import("@enduragent/kernel/ingest").ImportBatch,
      hooks?: Pick<ImportReportDeps, "finalizeBatchInTransaction" | "measurePhase">,
    ) {
      return importWith(batch, deps.prepareFile, hooks);
    },
    importBatchWithPreparation(
      batch: import("@enduragent/kernel/ingest").ImportBatch,
      prepareFile: ImportReportDeps["prepareFile"],
      hooks?: Pick<ImportReportDeps, "finalizeBatchInTransaction" | "measurePhase">,
    ) {
      if (typeof prepareFile !== "function") throw new TypeError("prepareFile must be a function");
      return importWith(batch, prepareFile, hooks);
    },
  });
}

export function setRepairFixerEnabled(
  options: SetRepairFixerEnabledOptions,
): Promise<RepairFixerSettingChangeResult> {
  return applyRepairFixerSettingWithRebuild(
    { fixer: options.fixer, enabled: options.enabled },
    createImportReportDeps(options),
  );
}
