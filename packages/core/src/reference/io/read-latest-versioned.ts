import { safeReadJson } from "../../io/safe-read-json.js";
import {
  LATEST_SCHEMA_VERSION,
  LatestJsonSchema,
  type LatestJson,
} from "../schemas/latest.js";

/**
 * Read the latest-cache envelope and version-gate it.
 *
 * Returns the parsed envelope only when its `metadata.schema_version` matches
 * the current `LATEST_SCHEMA_VERSION`. A version mismatch returns null so the
 * caller treats it as a cache miss and re-syncs — discard-and-resync, no
 * migration map (mirrors the safe-read-json doctrine).
 *
 * The equality gate runs AFTER safeReadJson because safeReadJson types
 * `schema_version` only as `z.string()`; a stale-but-shape-valid v1 file would
 * otherwise parse clean.
 */
export function readLatestVersioned(path: string): LatestJson | null {
  const result = safeReadJson<LatestJson>(path, LatestJsonSchema);
  if (result === null) {
    return null;
  }
  if (result.metadata.schema_version !== LATEST_SCHEMA_VERSION) {
    return null;
  }
  return result;
}
