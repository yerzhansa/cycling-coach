/**
 * Verdict logic for the differential fuzz-parity harness, split into a pure,
 * side-effect-free module so the "never report a vacuous pass" invariant can be
 * unit-tested without spinning up Pyodide (importing the harness itself would
 * trigger its top-level `main()`).
 *
 * The harness earns a pass ONLY by actually running the differential clean on
 * real inputs. A run that proved nothing — the oracle threw on everything, or
 * nothing was fuzzed at all — must never look like success.
 */

export type VerdictStatus = "ok" | "mismatch" | "oracle-error" | "empty";

export interface Verdict {
  /** Process exit code: 0 pass · 1 metric divergence · 2 broken/empty run. */
  code: 0 | 1 | 2;
  status: VerdictStatus;
}

export interface RunCounts {
  /** Fixtures on which the full TS-vs-oracle comparison actually ran. */
  compared: number;
  /** Fixtures the oracle threw on (returned `__error__`) and were skipped. */
  oracleErrors: number;
  /** Total metric mismatches summed across every compared fixture. */
  mismatchTotal: number;
}

/**
 * Strict gate: `code` is 0 IFF the run compared at least one fixture, the oracle
 * never threw, and no metric diverged. Any oracle error fails — a broken oracle
 * (e.g. an upstream signature drift on a SHA bump) invalidates the run, and a
 * partial-error run is just as vacuous as a total one. Oracle errors take
 * precedence over mismatches: fix the oracle first, then re-run for a clean
 * mismatch signal.
 */
export function decideVerdict({ compared, oracleErrors, mismatchTotal }: RunCounts): Verdict {
  if (oracleErrors > 0) return { code: 2, status: "oracle-error" };
  if (mismatchTotal > 0) return { code: 1, status: "mismatch" };
  if (compared === 0) return { code: 2, status: "empty" };
  return { code: 0, status: "ok" };
}
