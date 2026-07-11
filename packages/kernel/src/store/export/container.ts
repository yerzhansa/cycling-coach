import {
  type ExportCryptoPort,
  type TextCodec,
  PBKDF2_ITERATIONS,
  SALT_BYTES,
  NONCE_BYTES,
} from "./ports.js";

export function stableSerialize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableSerialize);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) sorted[key] = stableSerialize(record[key]);
    return sorted;
  }
  return value;
}
export function canonicalJson(value: unknown): string {
  return JSON.stringify(stableSerialize(value), null, 2);
}

// ASCII "ENDRXPRT" — the 8 magic bytes identifying an enduragent export file.
export const CONTAINER_MAGIC = Uint8Array.of(0x45, 0x4e, 0x44, 0x52, 0x58, 0x50, 0x52, 0x54);
export const EXPORT_FORMAT_VERSION = 1 as const;
export const MODE_PLAINTEXT = 0x00 as const;
export const MODE_PASSPHRASE = 0x01 as const;
export const KDF_PBKDF2_SHA256 = 0x01 as const;
export const AEAD_AES256_GCM = 0x01 as const;

const PLAINTEXT_HEADER_LEN = 10;
const PASSPHRASE_HEADER_LEN = 46;

export class ExportFormatError extends Error {
  constructor(message: string) { super(message); this.name = "ExportFormatError"; }
}
export class ExportPassphraseRequiredError extends Error {
  constructor(message: string) { super(message); this.name = "ExportPassphraseRequiredError"; }
}
export class ExportDecryptionError extends Error {
  constructor(message: string) { super(message); this.name = "ExportDecryptionError"; }
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export async function encodeContainer(
  document: unknown,
  deps: { codec: TextCodec; crypto: ExportCryptoPort },
  opts: { passphrase?: string },
): Promise<Uint8Array> {
  const payload = deps.codec.encodeUtf8(canonicalJson(document));
  if (!opts.passphrase) {
    return concatBytes([
      CONTAINER_MAGIC,
      Uint8Array.of(EXPORT_FORMAT_VERSION, MODE_PLAINTEXT),
      payload,
    ]);
  }
  const salt = deps.crypto.randomBytes(SALT_BYTES);
  const nonce = deps.crypto.randomBytes(NONCE_BYTES);
  const header = new Uint8Array(PASSPHRASE_HEADER_LEN);
  header.set(CONTAINER_MAGIC, 0);
  header[8] = EXPORT_FORMAT_VERSION;
  header[9] = MODE_PASSPHRASE;
  header[10] = KDF_PBKDF2_SHA256;
  new DataView(header.buffer, header.byteOffset).setUint32(11, PBKDF2_ITERATIONS, false);
  header[15] = SALT_BYTES;
  header.set(salt, 16);
  header[32] = AEAD_AES256_GCM;
  header[33] = NONCE_BYTES;
  header.set(nonce, 34);
  const ciphertext = await deps.crypto.encrypt({
    passphrase: opts.passphrase,
    salt,
    iterations: PBKDF2_ITERATIONS,
    nonce,
    aad: header,
    plaintext: payload,
  });
  return concatBytes([header, ciphertext]);
}

export async function decodeContainer(
  container: Uint8Array,
  deps: { codec: TextCodec; crypto: ExportCryptoPort },
  opts: { passphrase?: string },
): Promise<unknown> {
  if (container.length < PLAINTEXT_HEADER_LEN) {
    throw new ExportFormatError("This is not an enduragent export file.");
  }
  for (let i = 0; i < CONTAINER_MAGIC.length; i++) {
    if (container[i] !== CONTAINER_MAGIC[i]) {
      throw new ExportFormatError("This is not an enduragent export file.");
    }
  }
  if (container[8] !== EXPORT_FORMAT_VERSION) {
    throw new ExportFormatError(
      `Unsupported export format version ${container[8]}; update the app to read this file.`,
    );
  }
  const mode = container[9];
  if (mode === MODE_PLAINTEXT) {
    const text = deps.codec.decodeUtf8(container.subarray(PLAINTEXT_HEADER_LEN));
    return parseJsonPayload(text);
  }
  if (mode === MODE_PASSPHRASE) {
    if (!opts.passphrase) {
      throw new ExportPassphraseRequiredError(
        "This export is passphrase-protected; a passphrase is required to open it.",
      );
    }
    if (container.length < PASSPHRASE_HEADER_LEN) {
      throw new ExportFormatError("The export file header is corrupt or uses unsupported parameters.");
    }
    const kdfId = container[10];
    const iterations = new DataView(container.buffer, container.byteOffset).getUint32(11, false);
    const saltLen = container[15];
    const aeadId = container[32];
    const nonceLen = container[33];
    if (
      kdfId !== KDF_PBKDF2_SHA256 ||
      aeadId !== AEAD_AES256_GCM ||
      saltLen !== SALT_BYTES ||
      nonceLen !== NONCE_BYTES ||
      iterations < PBKDF2_ITERATIONS
    ) {
      throw new ExportFormatError("The export file header is corrupt or uses unsupported parameters.");
    }
    const salt = container.subarray(16, 16 + saltLen);
    const nonce = container.subarray(34, 34 + nonceLen);
    const ciphertext = container.subarray(PASSPHRASE_HEADER_LEN);
    const aad = container.subarray(0, PASSPHRASE_HEADER_LEN);
    // AES-GCM cannot distinguish a wrong passphrase from tampered bytes —
    // both surface as ExportDecryptionError. Do not attempt to tell them apart.
    let plaintext: Uint8Array;
    try {
      plaintext = await deps.crypto.decrypt({
        passphrase: opts.passphrase,
        salt,
        iterations,
        nonce,
        aad,
        ciphertext,
      });
    } catch {
      throw new ExportDecryptionError(
        "Could not decrypt the export: wrong passphrase, or the file has been modified.",
      );
    }
    return parseJsonPayload(deps.codec.decodeUtf8(plaintext));
  }
  throw new ExportFormatError("The export file header is corrupt or uses unsupported parameters.");
}

function parseJsonPayload(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new ExportFormatError("The export file is corrupt (payload is not valid JSON).");
  }
}
