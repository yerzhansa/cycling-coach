import { describe, expect, it } from "vitest";

import * as distribution from "./distribution.js";
import * as loadManagement from "./load-management.js";
import { METRIC_REGISTRY } from "./registry.js";

// Inverse coverage. The parity gate warns when a snapshot on disk has no
// METRIC_REGISTRY entry, but nothing asserts the other direction — that every
// compute* function shipped in a metric module is actually wired into the
// registry. Without this, a contributor can port a metric, forget to register
// it, and still ship green CI: the new metric is simply never checked. This
// test fails the moment an exported compute* function is missing from the
// registry.
describe("METRIC_REGISTRY inverse coverage", () => {
  it("registers every compute* function exported from the metric modules", () => {
    const registered = new Set<unknown>(
      Object.values(METRIC_REGISTRY).map((entry) => entry.compute),
    );

    const exported: string[] = [];
    const unregistered: string[] = [];
    for (const [moduleName, mod] of [
      ["distribution", distribution],
      ["load-management", loadManagement],
    ] as const) {
      for (const [name, value] of Object.entries(mod)) {
        if (!name.startsWith("compute") || typeof value !== "function") continue;
        exported.push(`${moduleName}.${name}`);
        if (!registered.has(value)) unregistered.push(`${moduleName}.${name}`);
      }
    }

    // Vacuity guard: discovery must find at least the registered set, or the
    // assertion below would pass trivially on an empty list.
    expect(exported.length).toBeGreaterThanOrEqual(Object.keys(METRIC_REGISTRY).length);
    expect(unregistered).toEqual([]);
  });
});
