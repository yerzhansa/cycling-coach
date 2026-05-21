/**
 * The contract between a metric port and the parity gate.
 *
 * The gate (`tools/check-metric-parity.ts`) loads each metric's snapshot,
 * resolves the registry entry to a function in this directory, and calls
 * it with this input shape. `frozenNow` matches the snapshot's
 * `frozen_now` field so the metric can derive date-relative windows that
 * line up with the captured oracle.
 */
export interface MetricInput {
  fixture: unknown;
  frozenNow: string;
}
