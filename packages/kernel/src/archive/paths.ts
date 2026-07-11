import type { ArchiveInstant } from "./types.js";

export const ADDRESS_HEX_LEN = 64;

const ADDRESS_RE = new RegExp(`^[0-9a-f]{${ADDRESS_HEX_LEN}}$`);

export class InvalidArtifactExtensionError extends Error {}
export class InvalidContentAddressError extends Error {}

/** Lowercase hex of a digest — the canonical content-address form ADDRESS_RE validates. */
export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/** Lowercase, strip a single leading dot, reject anything not /^[a-z0-9]+$/.
 *  Guards against path traversal and multi-segment extensions (snapshots use
 *  the fixed `.json.gz` suffix via snapshotRelPath, not this). */
export function normalizeExt(ext: string): string {
  let normalized = ext.toLowerCase();
  if (normalized.startsWith(".")) {
    normalized = normalized.slice(1);
  }
  if (!/^[a-z0-9]+$/.test(normalized)) {
    throw new InvalidArtifactExtensionError(`invalid artifact extension: ${ext}`);
  }
  return normalized;
}

/** Throw InvalidContentAddressError unless `address` is ADDRESS_HEX_LEN lowercase hex chars. */
export function assertValidAddress(address: string): void {
  if (!ADDRESS_RE.test(address)) {
    throw new InvalidContentAddressError(`invalid content address: ${address}`);
  }
}

/** UTC year (4-digit) + zero-padded 2-digit month from an ArchiveInstant. */
export function shardFromInstant(
  when: ArchiveInstant,
): { readonly year: string; readonly month: string } {
  const date = new Date(when.epochSeconds * 1000);
  const year = String(date.getUTCFullYear());
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return { year, month };
}

/** `<yyyy>/<mm>/<address>.<normalizedExt>` (validates address + ext). */
export function artifactRelPath(address: string, ext: string, when: ArchiveInstant): string {
  assertValidAddress(address);
  const normalizedExt = normalizeExt(ext);
  const { year, month } = shardFromInstant(when);
  return `${year}/${month}/${address}.${normalizedExt}`;
}

/** `<yyyy>/<mm>/<address>.json.gz` (validates address). */
export function snapshotRelPath(address: string, when: ArchiveInstant): string {
  assertValidAddress(address);
  const { year, month } = shardFromInstant(when);
  return `${year}/${month}/${address}.json.gz`;
}

/** `quarantine/<address>.<normalizedExt>` — flat, no shard (validates address + ext). */
export function quarantineRelPath(address: string, ext: string): string {
  assertValidAddress(address);
  const normalizedExt = normalizeExt(ext);
  return `quarantine/${address}.${normalizedExt}`;
}

/** `quarantine/<address>.<normalizedExt>.reason.txt` — the durable reason sidecar beside the bytes. */
export function quarantineReasonRelPath(address: string, ext: string): string {
  return `${quarantineRelPath(address, ext)}.reason.txt`;
}
