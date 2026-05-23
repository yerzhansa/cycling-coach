import { readFileSync } from "node:fs";
import type { ZodTypeAny } from "zod";

/**
 * Canonical read path for any Reference persisted state file.
 *
 * Returns:
 *   - the parsed value on success
 *   - `null` on missing file (ENOENT) — caller treats missing-is-normal
 *   - `null` on JSON syntax error — logs a single warn
 *   - `null` on Zod validation failure (including `.strict()` extra fields) —
 *     logs a single warn
 *   - `null` on permission error (EACCES) — logs a single warn
 *
 * Reference NEVER calls `JSON.parse(readFileSync(...))` directly. Always go
 * through this helper so error semantics are uniform across cache files,
 * scheduler state, error_state, and audit reads.
 *
 * Schema versioning is handled via Zod-strict-as-gate: when intervals.icu
 * adds a field, our `.strict()` parse fails here, the helper returns null,
 * the caller treats it as "cache miss" and triggers a fresh sync. There is
 * no `migrate-v1-to-v2.ts`.
 */
export function safeReadJson<T>(path: string, schema: ZodTypeAny): T | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err: unknown) {
    if (isErrnoCode(err, "ENOENT")) {
      // Missing file is normal — first run, after a wipe, between syncs. No warn.
      return null;
    }
    console.warn(
      `safeReadJson: failed to read ${path}: ${formatError(err)}`,
    );
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: unknown) {
    console.warn(`safeReadJson: invalid JSON at ${path}: ${formatError(err)}`);
    return null;
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    console.warn(
      `safeReadJson: schema validation failed at ${path}: ${result.error.message}`,
    );
    return null;
  }
  return result.data as T;
}

function isErrnoCode(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === code;
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
