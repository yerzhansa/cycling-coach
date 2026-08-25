import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import type { ManagedImageProjection } from "@enduragent/kernel/store";
import type { ManagedChatAttachmentStore } from "./managed-store.js";

export type ManagedImageExtension = "png" | "jpg" | "jpeg" | "webp";
export type NativeImageMediaType = "image/png" | "image/jpeg" | "image/webp";

export interface ManagedMediaReaderLimits {
  readonly imageBytes: number;
  readonly imageDimension: number;
  readonly imagePixels: number;
  readonly documentBytes: number;
  readonly pdfPages: number;
  readonly pdfVisualPages: number;
  readonly pdfVisualPixels: number;
  readonly pdfPageDimension: number;
  readonly parserMs: number;
  readonly parserOldGenerationMiB: number;
}

interface ManagedMediaSourceBase {
  readonly objectId: string;
  readonly relativePath: string;
  readonly byteSize: number;
  readonly sha256: string;
}

export interface ManagedImageSource extends ManagedMediaSourceBase {
  readonly extension: ManagedImageExtension;
}

export interface ManagedVisualPdfSource extends ManagedMediaSourceBase {
  readonly extension: "pdf";
  readonly pageNumbers: readonly number[];
}

export interface NativeMediaPayload {
  readonly mediaType: NativeImageMediaType;
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly pageNumber?: number;
}

export interface ManagedImageReadResult {
  readonly projection: ManagedImageProjection;
  readonly payload: NativeMediaPayload;
}

export interface ManagedMediaReader {
  readImage(source: ManagedImageSource): Promise<ManagedImageReadResult>;
  renderPdfPages(source: ManagedVisualPdfSource): Promise<readonly NativeMediaPayload[]>;
}

export type ManagedMediaReaderFailure =
  | "integrity_mismatch"
  | "limit_exceeded"
  | "parser_timeout"
  | "validation_failed"
  | "worker_failed";

export class ManagedMediaReaderError extends Error {
  constructor(readonly reason: ManagedMediaReaderFailure) {
    super("managed visual media could not be read");
    this.name = "ManagedMediaReaderError";
  }
}

export interface ManagedMediaReaderOptions {
  readonly objects: Pick<ManagedChatAttachmentStore, "readObjectBytes">;
  readonly limits: ManagedMediaReaderLimits;
  readonly workerUrl?: URL;
}

interface WorkerImageResult {
  readonly mediaType: unknown;
  readonly bytes: unknown;
  readonly width: unknown;
  readonly height: unknown;
}

interface WorkerPdfResult extends WorkerImageResult {
  readonly pageNumber: unknown;
}

interface WorkerSuccess {
  readonly ok: true;
  readonly kind: "image" | "pdf";
  readonly result: unknown;
}

interface WorkerFailure {
  readonly ok: false;
  readonly reason: unknown;
}

const SAFE_OBJECT_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const FAILURES = new Set<ManagedMediaReaderFailure>([
  "integrity_mismatch",
  "limit_exceeded",
  "parser_timeout",
  "validation_failed",
  "worker_failed",
]);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
}

function validateLimits(limits: ManagedMediaReaderLimits): void {
  for (const [name, value] of Object.entries(limits)) positiveInteger(value, name);
  if (limits.pdfVisualPages > limits.pdfPages) {
    throw new TypeError("pdfVisualPages cannot exceed pdfPages");
  }
}

function failure(reason: unknown): ManagedMediaReaderError {
  return new ManagedMediaReaderError(
    typeof reason === "string" && FAILURES.has(reason as ManagedMediaReaderFailure)
      ? (reason as ManagedMediaReaderFailure)
      : "worker_failed",
  );
}

function defaultWorkerUrl(): URL {
  const sourceModule = import.meta.url.endsWith(".ts");
  return new URL(
    sourceModule ? "./media-reader-worker.ts" : "./media-reader-worker.js",
    import.meta.url,
  );
}

function validSource(source: ManagedMediaSourceBase, maximumBytes: number): boolean {
  return (
    SAFE_OBJECT_ID.test(source.objectId) &&
    SHA256.test(source.sha256) &&
    Number.isSafeInteger(source.byteSize) &&
    source.byteSize > 0 &&
    source.byteSize <= maximumBytes
  );
}

function expectedMediaType(extension: ManagedImageExtension): NativeImageMediaType {
  if (extension === "png") return "image/png";
  if (extension === "webp") return "image/webp";
  return "image/jpeg";
}

function validatePayload(
  value: WorkerImageResult,
  limits: Pick<ManagedMediaReaderLimits, "imageDimension" | "imagePixels">,
  mediaType?: NativeImageMediaType,
): NativeMediaPayload {
  if (
    !(value.bytes instanceof Uint8Array) ||
    (value.mediaType !== "image/png" &&
      value.mediaType !== "image/jpeg" &&
      value.mediaType !== "image/webp") ||
    (mediaType !== undefined && value.mediaType !== mediaType) ||
    !Number.isSafeInteger(value.width) ||
    !Number.isSafeInteger(value.height) ||
    Number(value.width) < 1 ||
    Number(value.height) < 1 ||
    Number(value.width) > limits.imageDimension ||
    Number(value.height) > limits.imageDimension ||
    Number(value.width) * Number(value.height) > limits.imagePixels
  ) {
    throw failure("worker_failed");
  }
  return {
    mediaType: value.mediaType,
    bytes: Uint8Array.from(value.bytes),
    width: Number(value.width),
    height: Number(value.height),
  };
}

function runWorker(
  workerUrl: URL,
  request: Record<string, unknown>,
  bytes: Uint8Array,
  limits: ManagedMediaReaderLimits,
): Promise<WorkerSuccess> {
  return new Promise((resolve, reject) => {
    const transferable = Uint8Array.from(bytes);
    const worker = new Worker(workerUrl, {
      workerData: { ...request, bytes: transferable, limits },
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
    const timer = setTimeout(
      () => finish(() => reject(failure("parser_timeout"))),
      limits.parserMs,
    );
    timer.unref();
    worker.once("message", (message: WorkerSuccess | WorkerFailure) => {
      if (message?.ok === false) {
        finish(() => reject(failure(message.reason)));
      } else if (message?.ok === true) {
        finish(() => resolve(message));
      } else {
        finish(() => reject(failure("worker_failed")));
      }
    });
    worker.once("error", () => finish(() => reject(failure("worker_failed"))));
    worker.once("exit", () => finish(() => reject(failure("worker_failed"))));
  });
}

export function createManagedMediaReader(options: ManagedMediaReaderOptions): ManagedMediaReader {
  validateLimits(options.limits);
  const workerUrl = options.workerUrl ?? defaultWorkerUrl();
  const bytesFor = async (source: ManagedMediaSourceBase): Promise<Uint8Array> => {
    try {
      const bytes = await options.objects.readObjectBytes({
        relativePath: source.relativePath,
        byteSize: source.byteSize,
        sha256: source.sha256,
      });
      if (bytes.byteLength !== source.byteSize) throw new Error("size mismatch");
      return bytes;
    } catch {
      throw failure("integrity_mismatch");
    }
  };
  return Object.freeze({
    async readImage(source: ManagedImageSource): Promise<ManagedImageReadResult> {
      if (!validSource(source, options.limits.imageBytes)) throw failure("limit_exceeded");
      const result = await runWorker(
        workerUrl,
        { kind: "image", extension: source.extension },
        await bytesFor(source),
        options.limits,
      );
      if (result.kind !== "image" || result.result === null || typeof result.result !== "object") {
        throw failure("worker_failed");
      }
      const payload = validatePayload(
        result.result as WorkerImageResult,
        options.limits,
        expectedMediaType(source.extension),
      );
      if (
        payload.bytes.byteLength !== source.byteSize ||
        createHash("sha256").update(payload.bytes).digest("hex") !== source.sha256
      ) {
        throw failure("worker_failed");
      }
      return {
        projection: {
          kind: "managed-image",
          objectId: source.objectId,
          mediaType: payload.mediaType,
          width: payload.width,
          height: payload.height,
          pixels: payload.width * payload.height,
        },
        payload,
      };
    },
    async renderPdfPages(source: ManagedVisualPdfSource): Promise<readonly NativeMediaPayload[]> {
      if (
        !validSource(source, options.limits.documentBytes) ||
        source.pageNumbers.length < 1 ||
        source.pageNumbers.length > options.limits.pdfVisualPages ||
        source.pageNumbers.some(
          (pageNumber, index) =>
            !Number.isSafeInteger(pageNumber) ||
            pageNumber < 1 ||
            pageNumber > options.limits.pdfPages ||
            (index > 0 && pageNumber <= source.pageNumbers[index - 1]!),
        )
      ) {
        throw failure("limit_exceeded");
      }
      const result = await runWorker(
        workerUrl,
        { kind: "pdf", pageNumbers: source.pageNumbers },
        await bytesFor(source),
        options.limits,
      );
      if (result.kind !== "pdf" || !Array.isArray(result.result)) throw failure("worker_failed");
      let pixels = 0;
      const payloads = result.result.map((candidate, index) => {
        const item = candidate as WorkerPdfResult;
        if (item.pageNumber !== source.pageNumbers[index]) throw failure("worker_failed");
        const payload = validatePayload(
          item,
          {
            imageDimension: options.limits.pdfPageDimension,
            imagePixels: options.limits.pdfVisualPixels,
          },
          "image/png",
        );
        if (!Buffer.from(payload.bytes.subarray(0, 8)).equals(PNG_SIGNATURE)) {
          throw failure("worker_failed");
        }
        pixels += payload.width * payload.height;
        return { ...payload, pageNumber: Number(item.pageNumber) };
      });
      if (
        payloads.length !== source.pageNumbers.length ||
        pixels > options.limits.pdfVisualPixels
      ) {
        throw failure("worker_failed");
      }
      return payloads;
    },
  });
}
