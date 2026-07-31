import { toHex } from "../archive/paths.js";
import type { CryptoPort } from "../ports/crypto.js";

export class DerivedKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DerivedKeyError";
  }
}

export function encodeUtf8Strict(input: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < input.length; i++) {
    let cp = input.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff) {
      if (i + 1 >= input.length) throw new DerivedKeyError("unpaired UTF-16 surrogate");
      const lo = input.charCodeAt(++i);
      if (lo < 0xdc00 || lo > 0xdfff) throw new DerivedKeyError("unpaired UTF-16 surrogate");
      cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
    } else if (cp >= 0xdc00 && cp <= 0xdfff) {
      throw new DerivedKeyError("unpaired UTF-16 surrogate");
    }
    if (cp <= 0x7f) out.push(cp);
    else if (cp <= 0x7ff) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp <= 0xffff)
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
  }
  return Uint8Array.from(out);
}

export function compareUtf8(left: string, right: string): number {
  const a = encodeUtf8Strict(left);
  const b = encodeUtf8Strict(right);
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

export async function H(
  crypto: CryptoPort,
  ...fields: readonly [string | number, ...(string | number)[]]
): Promise<string> {
  if (fields.length === 0) throw new DerivedKeyError("empty key tuple");
  const encoded: Uint8Array[] = [];
  let byteLength = fields.length - 1;
  for (const field of fields) {
    let normalized: string;
    if (typeof field === "string") {
      normalized = field;
    } else if (typeof field === "number" && Number.isFinite(field) && Number.isSafeInteger(field)) {
      normalized = Object.is(field, -0) ? "0" : field.toString();
    } else {
      throw new DerivedKeyError("unsupported key field");
    }
    const bytes = encodeUtf8Strict(normalized);
    encoded.push(bytes);
    byteLength += bytes.length;
  }
  const framed = new Uint8Array(byteLength);
  let offset = 0;
  for (let i = 0; i < encoded.length; i++) {
    if (i > 0) framed[offset++] = 0x1f;
    framed.set(encoded[i], offset);
    offset += encoded[i].length;
  }
  return toHex(await crypto.sha256(framed));
}
