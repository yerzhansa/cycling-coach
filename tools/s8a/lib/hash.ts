import { createHash } from "node:crypto";

export function sha256_16(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

/** Production formula (raw JSON.stringify of the LIVE objects — never key-sorted). */
export function assembledHash(system: string, messages: unknown[]): string {
  return sha256_16(JSON.stringify({ system, messages }));
}
