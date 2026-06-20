import { join } from "node:path";
import { unlink } from "node:fs/promises";
import {
  ERROR_STATE_SCHEMA_VERSION,
  type ErrorPhase,
  type ErrorMitigation,
} from "../schemas/error-state.js";
import { atomicWriteJson } from "../../io/atomic-write-json.js";

export type { ErrorPhase };

export type ErrorStateWrite = (
  path: string,
  value: unknown,
  opts?: { signal?: AbortSignal },
) => Promise<void>;

/**
 * Atomic-write `error_state.json` to the data dir. Called by `runSync()`
 * when the outer 2-min timeout fires (with `phase` set per ADR-0011's
 * commit-marker-last write order), when the Layer-1 gate rejects a fetch
 * (with `phase` omitted), or on the soft-warn path (with
 * `mitigation: "warn_only"`). Cleared on the next fully-clean sync.
 *
 * The write is injectable (defaults to `atomicWriteJson`) and threads an
 * optional abort signal so a late body write skips its rename after the outer
 * timeout force-releases the mutex.
 */
export async function writeErrorState(
  dataDir: string,
  payload: {
    step: string;
    detail: string;
    phase?: ErrorPhase;
    mitigation?: ErrorMitigation;
  },
  opts?: { write?: ErrorStateWrite; signal?: AbortSignal },
): Promise<void> {
  const write = opts?.write ?? atomicWriteJson;
  await write(
    join(dataDir, "error_state.json"),
    {
      schema_version: ERROR_STATE_SCHEMA_VERSION,
      step: payload.step,
      detail: payload.detail,
      ts: new Date().toISOString(),
      ...(payload.phase !== undefined ? { phase: payload.phase } : {}),
      ...(payload.mitigation !== undefined ? { mitigation: payload.mitigation } : {}),
    },
    { signal: opts?.signal },
  );
}

/**
 * Best-effort remove `error_state.json`. Called on the fully-clean sync path
 * AFTER the `.scheduler.json` commit marker lands (ADR-0011 commit-marker-last)
 * so a curator reading mid-sync never sees a contradictory scheduler-fresh +
 * stale-error_state interleave. Swallows ENOENT — a missing file is the
 * desired post-state.
 */
export async function clearErrorState(
  dataDir: string,
  opts?: { signal?: AbortSignal },
): Promise<void> {
  if (opts?.signal?.aborted === true) return;
  try {
    await unlink(join(dataDir, "error_state.json"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
  }
}
