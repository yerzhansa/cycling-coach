// Structural assertions over the four sport-adapter shape stubs. The stubs'
// explicit `Pick<Sport, ...>` / `ReferenceSportAdapter` annotations are the
// primary drift signal (a renamed/required field fails their compilation); the
// runtime checks here pin the coverage-arithmetic edge cases the dispatcher and
// its invariants consume. Routing / disjoint-throw assertions belong to the
// dispatcher's own suite — this file only fixes the shapes.
import { describe, expect, it } from "vitest";

import { emptyArrayShape } from "./sport-shapes/empty-array-shape.js";
import { noAdapterShape } from "./sport-shapes/no-adapter-shape.js";
import { overlapAdapterShape } from "./sport-shapes/overlap-adapter-shape.js";
import { twoAdapterDuathlonShape } from "./sport-shapes/two-adapter-duathlon-shape.js";

describe("sport-adapter shape stubs", () => {
  it("no-adapter shape leaves referenceAdapters absent (optional method)", () => {
    expect(noAdapterShape.referenceAdapters).toBeUndefined();
  });

  it("empty-array shape returns an empty adapter list (method present, zero adapters)", () => {
    expect(noAdapterShape.referenceAdapters).not.toBe(emptyArrayShape.referenceAdapters);
    expect(emptyArrayShape.referenceAdapters?.()).toEqual([]);
  });

  it("two-adapter duathlon shape exposes two disjoint adapters covering all four types", () => {
    const adapters = twoAdapterDuathlonShape.referenceAdapters?.() ?? [];
    expect(adapters).toHaveLength(2);

    const flattened = adapters.flatMap((a) => [...a.activityTypes]).sort();
    expect(flattened).toEqual(["Ride", "Run", "TrailRun", "VirtualRide"]);

    // Disjoint: no activity type is claimed by more than one adapter.
    expect(new Set(flattened).size).toBe(flattened.length);

    // Subset coverage: the union is a subset of the sport's declared types.
    const declared = new Set(twoAdapterDuathlonShape.intervalsActivityTypes);
    for (const t of flattened) expect(declared.has(t)).toBe(true);
  });

  it("overlap shape is the intentionally-invalid two-adapter collision (both claim Ride)", () => {
    const adapters = overlapAdapterShape.referenceAdapters?.() ?? [];
    expect(adapters).toHaveLength(2);
    expect(adapters.every((a) => a.activityTypes.includes("Ride"))).toBe(true);

    // The collision the dispatcher must reject: "Ride" appears in both adapters,
    // so the flattened list has a duplicate.
    const flattened = adapters.flatMap((a) => [...a.activityTypes]);
    expect(new Set(flattened).size).toBeLessThan(flattened.length);
  });
});
