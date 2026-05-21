/**
 * Layer-1 sync gate per Reference PRD Decision 7. Wave-1 STUB — always
 * returns ok. Wave 4 / F15 replaces the body with the actual mechanical
 * checks (FTP source, weekly hours, UTC clock, tolerance bands, etc.).
 *
 * The call site exists in `runSync()` from Wave 1b onwards (between fetch
 * and cache-file writes), so F15's PR only changes the function body — it
 * doesn't introduce a new cross-wave seam.
 */
export interface GateFailure {
  readonly step: string;
  readonly detail: string;
}

export interface GateWarning {
  readonly step: string;
  readonly detail: string;
}

export interface GateResult {
  readonly ok: boolean;
  readonly failures: readonly GateFailure[];
  readonly warnings: readonly GateWarning[];
}

export function gateLatestJson(_fetched: unknown, _prior: unknown): GateResult {
  return { ok: true, failures: [], warnings: [] };
}
