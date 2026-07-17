import { Unzip, UnzipInflate } from "fflate";
import { compareBinary } from "./cursor.js";

export const BULK_FIT_BATCH_SIZE = 8;
export const MAX_ZIP_BYTES = 268_435_456;
export const MAX_FIT_BYTES = 134_217_728;
export const MAX_UNCOMPRESSED_BATCH_BYTES = 536_870_912;
export const BULK_SAFE_ACTIVITY_ID = /^[A-Za-z0-9.-]+$/;

export interface ExtractedFitEntry {
  readonly activityId: string;
  readonly filename: string;
  readonly bytes: Uint8Array;
}

export class IncompleteBulkFitBatchError extends Error {
  readonly requested: readonly string[];
  readonly returned: readonly string[];
  readonly missing: readonly string[];
  readonly unexpected: readonly string[];
  constructor(options: {
    readonly requested: readonly string[];
    readonly returned: readonly string[];
    readonly missing: readonly string[];
    readonly unexpected: readonly string[];
  }) {
    super("intervals.icu bulk FIT batch is incomplete");
    this.name = "IncompleteBulkFitBatchError";
    this.requested = Object.freeze([...options.requested].sort(compareBinary));
    this.returned = Object.freeze([...options.returned].sort(compareBinary));
    this.missing = Object.freeze([...options.missing].sort(compareBinary));
    this.unexpected = Object.freeze([...options.unexpected].sort(compareBinary));
    Object.freeze(this);
  }
}

export function extractBulkFitZip(bytes: Uint8Array, requestedInput: readonly string[]): readonly ExtractedFitEntry[] {
  const requested = [...requestedInput].sort(compareBinary);
  if (requested.length === 0 || requested.length > BULK_FIT_BATCH_SIZE
    || new Set(requested).size !== requested.length || requested.some((id) => !BULK_SAFE_ACTIVITY_ID.test(id))) {
    throw new TypeError("bulk FIT requested ids are invalid");
  }
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_ZIP_BYTES) throw new TypeError("bulk FIT ZIP size is invalid");
  const filenames = new Set<string>(), prefixes = new Set<string>();
  const entries: ExtractedFitEntry[] = [];
  let declaredTotal = 0, total = 0;
  const unzip = new Unzip((file) => {
    if (file.name.endsWith("/") || file.name.includes("/") || file.name.includes("\\")) {
      throw new TypeError("bulk FIT ZIP path is invalid");
    }
    if (filenames.has(file.name)) throw new TypeError("bulk FIT ZIP filename is duplicated");
    filenames.add(file.name);
    if (filenames.size > BULK_FIT_BATCH_SIZE) throw new TypeError("bulk FIT ZIP has too many entries");
    const match = /^([A-Za-z0-9.-]+)_(.+)\.fit$/.exec(file.name);
    if (match === null || match[2]!.length === 0) throw new TypeError("bulk FIT ZIP filename is invalid");
    const activityId = match[1]!;
    if (prefixes.has(activityId)) throw new TypeError("bulk FIT ZIP activity prefix is duplicated");
    prefixes.add(activityId);
    if (file.originalSize !== undefined) {
      if (file.originalSize > MAX_FIT_BYTES) throw new TypeError("bulk FIT entry is too large");
      declaredTotal += file.originalSize;
      if (declaredTotal > MAX_UNCOMPRESSED_BATCH_BYTES) throw new TypeError("bulk FIT batch is too large");
    }
    const chunks: Uint8Array[] = [];
    let length = 0;
    file.ondata = (error, chunk, final) => {
      if (error !== null) throw error;
      length += chunk.byteLength;
      total += chunk.byteLength;
      if (length > MAX_FIT_BYTES) throw new TypeError("bulk FIT entry is too large");
      if (total > MAX_UNCOMPRESSED_BATCH_BYTES) throw new TypeError("bulk FIT batch is too large");
      chunks.push(new Uint8Array(chunk));
      if (final) {
        if (length === 0) throw new TypeError("bulk FIT entry is empty");
        const output = new Uint8Array(length);
        let offset = 0;
        for (const value of chunks) { output.set(value, offset); offset += value.byteLength; }
        entries.push(Object.freeze({ activityId, filename: file.name, bytes: output }));
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  unzip.push(bytes, true);
  const returned = [...prefixes].sort(compareBinary);
  const requestedSet = new Set(requested), returnedSet = new Set(returned);
  const missing = requested.filter((id) => !returnedSet.has(id));
  const unexpected = returned.filter((id) => !requestedSet.has(id));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new IncompleteBulkFitBatchError({ requested, returned, missing, unexpected });
  }
  return Object.freeze(entries.sort((left, right) => compareBinary(left.activityId, right.activityId)));
}
