import type { ArchiveInstant } from "./types.js";

export const ADDRESS_HEX_LEN = 64;

export class InvalidArtifactExtensionError extends Error {}
export class InvalidContentAddressError extends Error {}

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

/** Throw InvalidContentAddressError unless `address` matches /^[0-9a-f]{64}$/. */
export function assertValidAddress(address: string): void {
  if (!/^[0-9a-f]{64}$/.test(address)) {
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
