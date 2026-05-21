/**
 * Authoritative list of metrics the parity gate can assert. Each entry
 * holds the typed compute function directly — the gate calls
 * `entry.compute(input)` without dynamic imports or path resolution.
 *
 * Adding a metric: implement it in a sibling file, import its `compute*`
 * function here, and register the entry. The Vitest matrix at
 * `packages/core/tests/reference-parity.test.ts` picks it up automatically.
 */

import type { MetricInput } from "./metric-input.js";
import { computeAcwr } from "./load-management.js";

export interface MetricRegistryEntry {
  compute: (input: MetricInput) => unknown;
}

export const METRIC_REGISTRY: Record<string, MetricRegistryEntry> = {
  acwr: { compute: computeAcwr },
};
