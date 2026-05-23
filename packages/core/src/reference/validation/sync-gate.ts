/**
 * Layer-1 sync gate. STUB — always returns ok. A future body will add
 * mechanical checks (FTP source, weekly hours, UTC clock, tolerance bands,
 * etc.).
 *
 * The call site already exists in `runSync()` (between fetch and cache-file
 * writes) so the future implementation is a body-only change, not a new
 * cross-layer seam.
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
