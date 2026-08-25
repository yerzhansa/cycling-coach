import { Worker } from "node:worker_threads";
import {
  parseNormalizedWorkoutSet,
  validateWorkoutParserLimits,
  type NormalizedWorkoutSet,
  type WorkoutParserLimits,
  type WorkoutSourceFormat,
} from "./types.js";
import type { WorkoutParseFailure } from "./parser.js";
import { hasCanonicalWorkoutIdentities } from "./parser.js";

export interface ManagedWorkoutReaderLimits extends WorkoutParserLimits {
  readonly workoutBytes: number;
  readonly parserMs: number;
  readonly parserOldGenerationMiB: number;
}

export interface ManagedWorkoutSource {
  readonly objectId: string;
  readonly relativePath: string;
  readonly displayName: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly extension: WorkoutSourceFormat;
}

export interface ManagedWorkoutObjectReader {
  readObjectBytes(input: {
    readonly relativePath: string;
    readonly byteSize: number;
    readonly sha256: string;
  }): Promise<Uint8Array>;
}

export type ManagedWorkoutReaderFailure =
  | WorkoutParseFailure
  | "integrity_mismatch"
  | "limit_exceeded"
  | "parser_timeout"
  | "worker_failed";

export class ManagedWorkoutReaderError extends Error {
  constructor(readonly reason: ManagedWorkoutReaderFailure) {
    super("managed planned workout could not be read");
    this.name = "ManagedWorkoutReaderError";
  }
}

export interface ManagedWorkoutReader {
  read(source: ManagedWorkoutSource): Promise<NormalizedWorkoutSet>;
}

export interface ManagedWorkoutReaderOptions {
  readonly objects: ManagedWorkoutObjectReader;
  readonly limits: ManagedWorkoutReaderLimits;
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
const FAILURES = new Set<ManagedWorkoutReaderFailure>([
  "invalid_utf8",
  "unsafe_xml",
  "malformed_xml",
  "invalid_structure",
  "invalid_timing",
  "invalid_target",
  "limit_exceeded",
  "unsupported_construct",
  "integrity_mismatch",
  "parser_timeout",
  "worker_failed",
]);

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
}

function validateLimits(limits: ManagedWorkoutReaderLimits): void {
  validateWorkoutParserLimits(limits);
  positiveInteger(limits.workoutBytes, "workoutBytes");
  positiveInteger(limits.parserMs, "parserMs");
  positiveInteger(limits.parserOldGenerationMiB, "parserOldGenerationMiB");
}

function error(reason: unknown): ManagedWorkoutReaderError {
  return new ManagedWorkoutReaderError(
    typeof reason === "string" && FAILURES.has(reason as ManagedWorkoutReaderFailure)
      ? (reason as ManagedWorkoutReaderFailure)
      : "worker_failed",
  );
}

function defaultWorkerUrl(): URL {
  const sourceModule = import.meta.url.endsWith(".ts");
  return new URL(sourceModule ? "./worker.ts" : "./worker.js", import.meta.url);
}

function runWorker(
  workerUrl: URL,
  source: ManagedWorkoutSource,
  bytes: Uint8Array,
  limits: ManagedWorkoutReaderLimits,
): Promise<NormalizedWorkoutSet> {
  return new Promise((resolve, reject) => {
    const transferable = Uint8Array.from(bytes);
    const worker = new Worker(workerUrl, {
      workerData: {
        bytes: transferable,
        sourceFormat: source.extension,
        sourceSha256: source.sha256,
        limits: {
          candidates: limits.candidates,
          segmentsPerWorkout: limits.segmentsPerWorkout,
          durationSeconds: limits.durationSeconds,
          diagnostics: limits.diagnostics,
          diagnosticChars: limits.diagnosticChars,
          titleChars: limits.titleChars,
          purposeChars: limits.purposeChars,
        },
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
        const result = parseNormalizedWorkoutSet(message.result, limits);
        if (
          result.sourceFormat !== source.extension ||
          !hasCanonicalWorkoutIdentities(result, source.sha256) ||
          result.workouts.length > limits.candidates
        ) {
          throw error("worker_failed");
        }
        finish(() => resolve(result));
      } catch (workerError) {
        finish(() => reject(workerError));
      }
    });
    worker.once("error", () => finish(() => reject(error("worker_failed"))));
    worker.once("exit", () => finish(() => reject(error("worker_failed"))));
  });
}

export function createManagedWorkoutReader(
  options: ManagedWorkoutReaderOptions,
): ManagedWorkoutReader {
  validateLimits(options.limits);
  const workerUrl = options.workerUrl ?? defaultWorkerUrl();
  return Object.freeze({
    async read(source: ManagedWorkoutSource): Promise<NormalizedWorkoutSet> {
      if (
        !SAFE_OBJECT_ID.test(source.objectId) ||
        source.displayName.length < 1 ||
        source.displayName.length > 512 ||
        !Number.isSafeInteger(source.byteSize) ||
        source.byteSize < 1 ||
        source.byteSize > options.limits.workoutBytes ||
        !SHA256.test(source.sha256) ||
        (source.extension !== "zwo" && source.extension !== "mrc" && source.extension !== "erg")
      ) {
        throw error("limit_exceeded");
      }
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
      return runWorker(workerUrl, source, bytes, options.limits);
    },
  });
}
