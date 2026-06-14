/**
 * Guards the per-sport adapter delegation seam. A per-sport adapter that
 * surfaces a registry-owned metric delegates to the registry compute and
 * projects its output — it must never register a second compute or re-derive.
 *
 * Three surfaces are pinned:
 *   1. The delegation targets (`computeDfaA1Profile`, `computePowerCurveDelta`,
 *      and the `MetricInput` type) are reachable from `@enduragent/core`, so a
 *      downstream adapter can import them without reaching into core internals.
 *   2. The registry key set is byte-identical to the recorded baseline — no new
 *      `capability.*` writer slipped in. Parity-green alone can't prove this: a
 *      redundant entry would ADD a passing case, not fail one.
 *   3. The registry itself is NOT reachable from the public barrel, so a sport
 *      package cannot acquire it without deep-importing core internals (the form
 *      the registry-isolation lint catches). Defense in depth for that lint.
 */

import { describe, it, expect, expectTypeOf } from "vitest";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeDfaA1Profile,
  computePowerCurveDelta,
  type MetricInput,
} from "@enduragent/core";
import * as corePublicApi from "@enduragent/core";
import { METRIC_REGISTRY } from "../src/reference/metrics/registry.js";

const REGISTRY_KEYS_BASELINE = [
  "acwr",
  "benchmark_indoor",
  "benchmark_outdoor",
  "capability.dfa_a1_profile",
  "capability.durability",
  "capability.efficiency_factor",
  "capability.hr_curve_delta",
  "capability.hrrc",
  "capability.power_curve_delta",
  "capability.sustainability_profile",
  "capability.tid_comparison",
  "consistency_details",
  "consistency_index",
  "easy_time_ratio",
  "easy_time_ratio_note",
  "effective_monotony",
  "effort_response_signal",
  "eftp",
  "grey_zone_note",
  "grey_zone_percentage",
  "has_intervals",
  "load_recovery_ratio",
  "monotony",
  "monotony_interpretation",
  "multi_sport_detected",
  "p_max",
  "power_model_source",
  "primary_sport_monotony",
  "quality_intensity_note",
  "quality_intensity_percentage",
  "recovery_index",
  "seasonal_context",
  "seiler_tid_28d",
  "seiler_tid_28d_primary",
  "seiler_tid_7d",
  "seiler_tid_7d_primary",
  "strain",
  "stress_tolerance",
  "vo2max",
  "w_prime",
  "w_prime_kj",
  "weight_signal",
  "zone_distribution_7d",
] as const;

describe("Reference adapter delegation surface", () => {
  it("exposes the capability delegation targets from the public barrel", () => {
    expect(typeof computeDfaA1Profile).toBe("function");
    expect(typeof computePowerCurveDelta).toBe("function");
    expectTypeOf<MetricInput>().toMatchTypeOf<{ frozenNow: string }>();
  });
});

describe("registry stays the sole writer of the capability metrics (OP1)", () => {
  it("has no new key beyond the recorded baseline", () => {
    const keys = Object.keys(METRIC_REGISTRY).sort();
    expect(keys).toEqual([...REGISTRY_KEYS_BASELINE]);
  });

  it("does not leak the registry through the public barrel", () => {
    expect("METRIC_REGISTRY" in corePublicApi).toBe(false);
  });

  it("blocks deep package-specifier imports into core internals", () => {
    // vitest resolves through Vite, which ignores Node's package `exports`
    // field, so the boundary is asserted under Node's own loader via a child.
    const corePkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const probe =
      "import('@enduragent/core/dist/reference/metrics/registry.js')" +
      ".then(() => process.stdout.write('RESOLVED'))" +
      ".catch((err) => process.stdout.write(String(err?.code)));";
    const reported = execFileSync(
      process.execPath,
      ["--input-type=module", "-e", probe],
      { cwd: corePkgRoot, encoding: "utf8" },
    );
    expect(reported).toBe("ERR_PACKAGE_PATH_NOT_EXPORTED");
  });
});
