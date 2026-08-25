import { Worker } from "node:worker_threads";
import {
  FIT_INGEST_VERSION,
  normalizeRepairFixerSettings,
  type ImportArtifact,
  type PrepareFileResult,
  type RepairFixerSettings,
} from "@enduragent/kernel/ingest";
import type { ManagedChatAttachmentStore } from "./managed-store.js";
import type { ParsedActivityProjection } from "@enduragent/kernel/store";

export type ManagedActivityExtension = "fit" | "tcx" | "gpx";

export const MANAGED_ACTIVITY_PARSER_VERSION = `canonical-ingest-${FIT_INGEST_VERSION}-worker-v1`;

export interface ManagedActivityReaderLimits {
  readonly activityBytes: number;
  readonly parserMs: number;
  readonly parserOldGenerationMiB: number;
  readonly sessions: number;
}

export interface ManagedActivitySource {
  readonly objectId: string;
  readonly relativePath: string;
  readonly displayName: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly extension: ManagedActivityExtension;
}

export type ManagedActivityReadResult =
  | {
      readonly outcome: "prepared";
      readonly projection: ParsedActivityProjection;
      readonly artifact: ImportArtifact;
      readonly prepared: Extract<PrepareFileResult, { readonly outcome: "prepared" }>;
    }
  | {
      readonly outcome: "quarantined";
      readonly code: string;
      readonly message: string;
    };

export type ManagedActivityReaderFailure =
  | "integrity_mismatch"
  | "limit_exceeded"
  | "parser_timeout"
  | "validation_failed"
  | "worker_failed";

export class ManagedActivityReaderError extends Error {
  constructor(readonly reason: ManagedActivityReaderFailure) {
    super("managed activity could not be read");
    this.name = "ManagedActivityReaderError";
  }
}

export interface ManagedActivityReader {
  read(
    source: ManagedActivitySource,
    repairSettings: RepairFixerSettings,
  ): Promise<ManagedActivityReadResult>;
}

export interface ManagedActivityReaderOptions {
  readonly objects: Pick<ManagedChatAttachmentStore, "readObjectBytes">;
  readonly limits: ManagedActivityReaderLimits;
  readonly workerUrl?: URL;
}

interface WorkerSuccess {
  readonly ok: true;
  readonly result: unknown;
}

interface WorkerFailure {
  readonly ok: false;
  readonly reason: unknown;
}

const SHA256 = /^[0-9a-f]{64}$/u;
const SAFE_OBJECT_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const FAILURES = new Set<ManagedActivityReaderFailure>([
  "integrity_mismatch",
  "limit_exceeded",
  "parser_timeout",
  "validation_failed",
  "worker_failed",
]);

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
}

function validateLimits(limits: ManagedActivityReaderLimits): void {
  positiveInteger(limits.activityBytes, "activityBytes");
  positiveInteger(limits.parserMs, "parserMs");
  positiveInteger(limits.parserOldGenerationMiB, "parserOldGenerationMiB");
  positiveInteger(limits.sessions, "sessions");
}

function error(reason: unknown): ManagedActivityReaderError {
  return new ManagedActivityReaderError(
    typeof reason === "string" && FAILURES.has(reason as ManagedActivityReaderFailure)
      ? (reason as ManagedActivityReaderFailure)
      : "worker_failed",
  );
}

function defaultWorkerUrl(): URL {
  const sourceModule = import.meta.url.endsWith(".ts");
  return new URL(
    sourceModule ? "./activity-reader-worker.ts" : "./activity-reader-worker.js",
    import.meta.url,
  );
}

function validatePreparedResult(
  value: unknown,
  source: ManagedActivitySource,
  limits: ManagedActivityReaderLimits,
): PrepareFileResult {
  if (value === null || typeof value !== "object" || !("outcome" in value)) {
    throw error("worker_failed");
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.outcome === "quarantined") {
    const quarantine = candidate.quarantine as Record<string, unknown> | undefined;
    if (
      quarantine === undefined ||
      typeof quarantine.code !== "string" ||
      quarantine.code.length < 1 ||
      quarantine.code.length > 128 ||
      typeof quarantine.message !== "string" ||
      quarantine.message.length < 1 ||
      quarantine.message.length > 2_048
    ) {
      throw error("worker_failed");
    }
    return value as PrepareFileResult;
  }
  if (candidate.outcome !== "prepared") throw error("worker_failed");
  const prepared = candidate.value as Record<string, unknown> | undefined;
  const rawFile = prepared?.raw_file as Record<string, unknown> | undefined;
  const candidates = prepared?.candidates;
  const summaries = prepared?.summaries;
  const repairEvents = prepared?.repair_events;
  if (
    prepared === undefined ||
    prepared.expected_address !== source.sha256 ||
    rawFile?.sha256 !== source.sha256 ||
    rawFile.bytes !== source.byteSize ||
    !Array.isArray(candidates) ||
    candidates.length < 1 ||
    candidates.length > limits.sessions ||
    !Array.isArray(summaries) ||
    summaries.length !== candidates.length ||
    !Array.isArray(repairEvents) ||
    repairEvents.length > limits.sessions * 32
  ) {
    throw error("worker_failed");
  }
  return value as PrepareFileResult;
}

function runWorker(
  workerUrl: URL,
  source: ManagedActivitySource,
  bytes: Uint8Array,
  repairSettings: RepairFixerSettings,
  limits: ManagedActivityReaderLimits,
): Promise<PrepareFileResult> {
  return new Promise((resolve, reject) => {
    const transferable = Uint8Array.from(bytes);
    const worker = new Worker(workerUrl, {
      workerData: {
        inputPath: `chat-attachment:${source.objectId}/${source.displayName}`,
        extension: source.extension,
        bytes: transferable,
        repairSettings,
      },
      transferList: [transferable.buffer],
      resourceLimits: { maxOldGenerationSizeMb: limits.parserOldGenerationMiB },
    });
    let settled = false;
    const finish = (work: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      work();
      void worker.terminate();
    };
    const timer = setTimeout(() => finish(() => reject(error("parser_timeout"))), limits.parserMs);
    timer.unref();
    worker.once("message", (message: WorkerSuccess | WorkerFailure) => {
      if (message?.ok === false) {
        finish(() => reject(error(message.reason)));
        return;
      }
      if (message?.ok !== true) {
        finish(() => reject(error("worker_failed")));
        return;
      }
      try {
        const result = validatePreparedResult(message.result, source, limits);
        finish(() => resolve(result));
      } catch (workerError) {
        finish(() => reject(workerError));
      }
    });
    worker.once("error", () => finish(() => reject(error("worker_failed"))));
    worker.once("exit", () => finish(() => reject(error("worker_failed"))));
  });
}

export function createManagedActivityReader(
  options: ManagedActivityReaderOptions,
): ManagedActivityReader {
  validateLimits(options.limits);
  const workerUrl = options.workerUrl ?? defaultWorkerUrl();
  const reader: ManagedActivityReader = {
    async read(
      source: ManagedActivitySource,
      repairSettings: RepairFixerSettings,
    ): Promise<ManagedActivityReadResult> {
      if (
        !SAFE_OBJECT_ID.test(source.objectId) ||
        source.displayName.length < 1 ||
        source.displayName.length > 512 ||
        !Number.isSafeInteger(source.byteSize) ||
        source.byteSize < 1 ||
        source.byteSize > options.limits.activityBytes ||
        !SHA256.test(source.sha256) ||
        (source.extension !== "fit" && source.extension !== "tcx" && source.extension !== "gpx")
      ) {
        throw error("limit_exceeded");
      }
      const normalizedSettings = normalizeRepairFixerSettings(repairSettings);
      let bytes: Uint8Array;
      try {
        bytes = await options.objects.readObjectBytes({
          relativePath: source.relativePath,
          byteSize: source.byteSize,
          sha256: source.sha256,
        });
      } catch {
        throw error("integrity_mismatch");
      }
      if (bytes.byteLength !== source.byteSize) throw error("integrity_mismatch");
      const prepared = await runWorker(
        workerUrl,
        source,
        bytes,
        normalizedSettings,
        options.limits,
      );
      if (prepared.outcome === "quarantined") {
        return {
          outcome: "quarantined",
          code: prepared.quarantine.code,
          message: prepared.quarantine.message,
        };
      }
      return {
        outcome: "prepared",
        projection: {
          kind: "parsed-activity",
          parsedActivityId: source.sha256,
          sourceFormat: source.extension,
          parserVersion: MANAGED_ACTIVITY_PARSER_VERSION,
        },
        artifact: {
          input_path: `chat-attachment:${source.objectId}/${source.displayName}`,
          bytes,
          ext: source.extension,
        },
        prepared,
      };
    },
  };
  return Object.freeze(reader);
}
