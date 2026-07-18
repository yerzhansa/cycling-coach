import type { DfaSummary } from "@enduragent/engine/sport";
import { computeDfaA1Profile, type MetricInput } from "@enduragent/kernel/reference/metrics";

/**
 * Project the parity-green DFA a1 profile down to the thin athlete-facing
 * summary. Delegates entirely to the registry compute — no re-derivation.
 */
export function projectDfaSummary(input: MetricInput): DfaSummary | null {
  const profile = computeDfaA1Profile(input);
  if (profile === null) return null;
  const { sufficient, avg } = profile.latest_session;
  // Mirror `sufficient` faithfully and gate only `value`: an insufficient
  // session has a null avg, so omitting `value` is enough — never flip
  // `sufficient` to false just because avg is absent.
  return { sufficient, ...(avg !== null ? { value: avg } : {}) };
}
