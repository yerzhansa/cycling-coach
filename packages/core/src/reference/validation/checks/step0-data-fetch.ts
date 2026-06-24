/**
 * Step 0 (HARD): all five source envelopes were fetched. Maps to the upstream
 * protocol's data-fetch precondition. See `NOTICE.md` for license attribution.
 */
import type { FetchedReference } from "../../sync/run-sync.js";
import type { CheckResult, GateFailure } from "../sync-gate.js";

const TOP_LEVEL_KEYS: readonly (keyof FetchedReference)[] = [
  "latest",
  "history",
  "intervals",
  "routes",
  "ftp_history",
];

export function checkDataFetch(fetched: FetchedReference): CheckResult {
  const failures: GateFailure[] = [];

  if (fetched === null || fetched === undefined) {
    return {
      failures: [{ step: "step0_data_fetch", detail: "source envelope missing: <root>" }],
      warnings: [],
    };
  }

  const envelope = fetched as unknown as Record<string, unknown>;
  for (const key of TOP_LEVEL_KEYS) {
    const value = envelope[key];
    if (value === null || value === undefined) {
      failures.push({ step: "step0_data_fetch", detail: `source envelope missing: ${key}` });
    }
  }

  // A present-but-errored envelope (a fetch that failed and was filled with an
  // empty fallback) is distinct from a present-but-legitimately-empty one: the
  // presence null-check above passes both, but the data-fetch precondition is
  // "every source envelope was fetched", so an errored endpoint must hard-fail
  // rather than commit empty data behind a fresh stamp.
  for (const e of fetched.fetch_errors ?? []) {
    failures.push({
      step: "step0_data_fetch",
      detail: `source endpoint errored: ${e.endpoint} (${e.detail})`,
    });
  }

  return { failures, warnings: [] };
}
