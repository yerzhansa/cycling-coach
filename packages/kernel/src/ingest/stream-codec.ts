import { unzlibSync, zlibSync } from "fflate";

export const STREAM_ENCODING = "f64:raw:zdeflate:le" as const;
export type StreamKind = "time" | "value";
export type StreamCodecErrorCode =
  | "unsupported_encoding"
  | "inflate_failed"
  | "bad_magic"
  | "bad_version"
  | "bad_dtype"
  | "bad_delta"
  | "bad_endian"
  | "invalid_n"
  | "n_mismatch"
  | "bitmap_length"
  | "high_bitmap_bits"
  | "payload_length"
  | "trailing_bytes"
  | "missing_slot_nonzero"
  | "present_nonfinite"
  | "time_missing"
  | "time_nonmonotonic"
  | "all_missing";

export class StreamCodecError extends Error {
  readonly code: StreamCodecErrorCode;
  constructor(code: StreamCodecErrorCode) {
    super(`stream codec rejected: ${code}`);
    this.name = "StreamCodecError";
    this.code = code;
  }
}

export interface EncodedStream {
  readonly encoding: typeof STREAM_ENCODING;
  readonly n: number;
  readonly data: Uint8Array;
}
export interface DecodeStreamInput {
  readonly encoding: string;
  readonly n: number;
  readonly kind: StreamKind;
  readonly data: Uint8Array;
  readonly maxInflatedBytes?: number;
}

function validN(n: number): boolean {
  return Number.isSafeInteger(n) && n >= 1 && n <= 0xffffffff;
}

export function encodeStream(kind: StreamKind, values: readonly (number | null)[]): EncodedStream {
  const n = values.length;
  if (!validN(n)) throw new StreamCodecError("invalid_n");
  for (const value of values) {
    if (value !== null && (typeof value !== "number" || !Number.isFinite(value))) {
      throw new StreamCodecError("present_nonfinite");
    }
  }
  if (kind === "time") {
    if (values.some((value) => value === null)) throw new StreamCodecError("time_missing");
    for (let i = 1; i < n; i++) {
      if ((values[i] as number) <= (values[i - 1] as number)) {
        throw new StreamCodecError("time_nonmonotonic");
      }
    }
  } else if (values.every((value) => value === null)) {
    throw new StreamCodecError("all_missing");
  }

  const bitmapLength = Math.ceil(n / 8);
  const payload = new Uint8Array(16 + bitmapLength + n * 8);
  payload.set([0x53, 0x54, 0x52, 0x4d, 1, 1, 0, 0]);
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  view.setUint32(8, n, true);
  view.setUint32(12, bitmapLength, true);
  for (let i = 0; i < n; i++) {
    const value = values[i];
    if (value !== null) {
      payload[16 + Math.floor(i / 8)] |= 1 << (i % 8);
      view.setFloat64(16 + bitmapLength + i * 8, Object.is(value, -0) ? 0 : value, true);
    }
  }
  return { encoding: STREAM_ENCODING, n, data: zlibSync(payload, { level: 6 }) };
}

export function decodeStream(input: DecodeStreamInput): readonly (number | null)[] {
  if (input.encoding !== STREAM_ENCODING) throw new StreamCodecError("unsupported_encoding");
  if (!validN(input.n)) throw new StreamCodecError("invalid_n");
  const maxInflatedBytes = input.maxInflatedBytes;
  if (
    maxInflatedBytes !== undefined &&
    (!Number.isSafeInteger(maxInflatedBytes) ||
      maxInflatedBytes < 0 ||
      maxInflatedBytes >= 0xffffffff)
  ) {
    throw new StreamCodecError("payload_length");
  }
  let payload: Uint8Array;
  try {
    payload =
      maxInflatedBytes === undefined
        ? unzlibSync(input.data)
        : unzlibSync(input.data, { out: new Uint8Array(maxInflatedBytes + 1) });
  } catch {
    throw new StreamCodecError("inflate_failed");
  }
  if (maxInflatedBytes !== undefined && payload.length > maxInflatedBytes) {
    throw new StreamCodecError("payload_length");
  }
  if (payload.length < 16) throw new StreamCodecError("payload_length");
  if (payload[0] !== 0x53 || payload[1] !== 0x54 || payload[2] !== 0x52 || payload[3] !== 0x4d)
    throw new StreamCodecError("bad_magic");
  if (payload[4] !== 1) throw new StreamCodecError("bad_version");
  if (payload[5] !== 1) throw new StreamCodecError("bad_dtype");
  if (payload[6] !== 0) throw new StreamCodecError("bad_delta");
  if (payload[7] !== 0) throw new StreamCodecError("bad_endian");
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const headerN = view.getUint32(8, true);
  if (!validN(headerN)) throw new StreamCodecError("invalid_n");
  if (headerN !== input.n) throw new StreamCodecError("n_mismatch");
  const bitmapLength = view.getUint32(12, true);
  const expectedBitmapLength = Math.ceil(headerN / 8);
  if (bitmapLength !== expectedBitmapLength) throw new StreamCodecError("bitmap_length");
  const expectedLength = 16 + bitmapLength + headerN * 8;
  if (payload.length < expectedLength) throw new StreamCodecError("payload_length");
  if (payload.length > expectedLength) throw new StreamCodecError("trailing_bytes");
  const unusedBits = bitmapLength * 8 - headerN;
  if (unusedBits > 0 && (payload[16 + bitmapLength - 1] & (0xff << (8 - unusedBits))) !== 0) {
    throw new StreamCodecError("high_bitmap_bits");
  }
  const values: (number | null)[] = [];
  for (let i = 0; i < headerN; i++) {
    const present = (payload[16 + Math.floor(i / 8)] & (1 << (i % 8))) !== 0;
    const valueOffset = 16 + bitmapLength + i * 8;
    if (!present) {
      for (let j = 0; j < 8; j++) {
        if (payload[valueOffset + j] !== 0) throw new StreamCodecError("missing_slot_nonzero");
      }
      values.push(null);
    } else {
      const value = view.getFloat64(valueOffset, true);
      if (!Number.isFinite(value)) throw new StreamCodecError("present_nonfinite");
      values.push(Object.is(value, -0) ? 0 : value);
    }
  }
  if (input.kind === "time") {
    if (values.some((value) => value === null)) throw new StreamCodecError("time_missing");
    for (let i = 1; i < values.length; i++) {
      if ((values[i] as number) <= (values[i - 1] as number)) {
        throw new StreamCodecError("time_nonmonotonic");
      }
    }
  } else if (values.every((value) => value === null)) {
    throw new StreamCodecError("all_missing");
  }
  return values;
}
