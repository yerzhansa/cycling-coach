// Adapted from CrankAddict/section-11 (MIT, 2026); see NOTICE.md.

import { join } from "node:path";
import {
  ERROR_STATE_SCHEMA_VERSION,
  type ErrorPhase,
} from "../schemas/error-state.js";
import { atomicWriteJson } from "../io/atomic-write.js";

export type { ErrorPhase };

/**
 * Atomic-write `error_state.json` to the data dir. Called by `runSync()`
 * when the outer 2-min timeout fires (with `phase` set per ADR-0011's
 * commit-marker-last write order) or when the Layer-1 gate rejects a fetch
 * (with `phase` omitted). Cleared on the next successful sync.
 */
export async function writeErrorState(
  dataDir: string,
  payload: { step: string; detail: string; phase?: ErrorPhase },
): Promise<void> {
  await atomicWriteJson(join(dataDir, "error_state.json"), {
    schema_version: ERROR_STATE_SCHEMA_VERSION,
    step: payload.step,
    detail: payload.detail,
    ts: new Date().toISOString(),
    ...(payload.phase !== undefined ? { phase: payload.phase } : {}),
  });
}
