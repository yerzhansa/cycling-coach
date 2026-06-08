import { join } from "node:path";
import { unlink } from "node:fs/promises";
import {
  ERROR_STATE_SCHEMA_VERSION,
  type ErrorPhase,
  type ErrorMitigation,
} from "../schemas/error-state.js";
import { atomicWriteJson } from "../../io/atomic-write-json.js";

export type { ErrorPhase };

/**
 * Atomic-write `error_state.json` to the data dir. Called by `runSync()`
 * when the outer 2-min timeout fires (with `phase` set per ADR-0011's
 * commit-marker-last write order), when the Layer-1 gate rejects a fetch
 * (with `phase` omitted), or on the soft-warn path (with
 * `mitigation: "warn_only"`). Cleared on the next fully-clean sync.
 */
export async function writeErrorState(
  dataDir: string,
  payload: {
    step: string;
    detail: string;
    phase?: ErrorPhase;
    mitigation?: ErrorMitigation;
  },
): Promise<void> {
  await atomicWriteJson(join(dataDir, "error_state.json"), {
    schema_version: ERROR_STATE_SCHEMA_VERSION,
    step: payload.step,
    detail: payload.detail,
    ts: new Date().toISOString(),
    ...(payload.phase !== undefined ? { phase: payload.phase } : {}),
    ...(payload.mitigation !== undefined ? { mitigation: payload.mitigation } : {}),
  });
}

/**
 * Best-effort remove `error_state.json`. Called on the fully-clean sync path
 * AFTER the `.scheduler.json` commit marker lands (ADR-0011 commit-marker-last)
 * so a curator reading mid-sync never sees a contradictory scheduler-fresh +
 * stale-error_state interleave. Swallows ENOENT — a missing file is the
 * desired post-state.
 */
export async function clearErrorState(dataDir: string): Promise<void> {
  try {
    await unlink(join(dataDir, "error_state.json"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
  }
}
