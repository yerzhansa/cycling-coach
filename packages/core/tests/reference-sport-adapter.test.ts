/**
 * Type-only landing of `ReferenceSportAdapter` and the optional
 * `Sport.referenceAdapters?()` method. There is no runtime behavior to
 * assert (no sport implements the field yet; integration lands later).
 *
 * What we verify here:
 *   1. The new types are exported from `@enduragent/core`'s public surface.
 *   2. A literal conforming to `ReferenceSportAdapter` typechecks.
 *   3. A `Sport`-shaped object literal that omits `referenceAdapters` still
 *      typechecks (the method is optional — existing cycling sport stays valid).
 *   4. A `Sport`-shaped literal that DOES implement `referenceAdapters` returns
 *      a `readonly` array with the expected element shape.
 *   5. The duathlon composition pattern compiles: `() => [...c.referenceAdapters!(),
 *      ...r.referenceAdapters!()]` (per ADR-0002 + ADR-0010).
 *
 * If the interface drifts (a field is renamed, made required, etc.), this
 * file fails to compile, and vitest reports the suite as failed before any
 * runtime assertion runs.
 */

import { describe, it, expect } from "vitest";
import type {
  DfaSummary,
  PowerCurveDeltaSummary,
  ReferenceSportAdapter,
  Sport,
} from "../src/index.js";

describe("ReferenceSportAdapter type surface", () => {
  it("ReferenceSportAdapter is exported and accepts a metadata-only adapter", () => {
    const declarativeOnly: ReferenceSportAdapter = {
      activityTypes: ["Ride", "VirtualRide"] as const,
      zoneBasis: "power",
      decouplingBasis: "power",
      sustainabilityAnchors: [60, 90, 120, 180, 240],
      dfaValidated: true,
    };
    expect(declarativeOnly.activityTypes.length).toBeGreaterThan(0);
    expect(declarativeOnly.zoneBasis).toBe("power");
  });

  it("ReferenceSportAdapter accepts optional algorithm hooks", () => {
    const fakeDfa: DfaSummary = { sufficient: true, value: 0.78 };
    const fakeCurveDelta: PowerCurveDeltaSummary = { anchorsCovered: 5, trend: "up" };

    const withHooks: ReferenceSportAdapter = {
      activityTypes: ["Ride"] as const,
      zoneBasis: "power",
      decouplingBasis: "power",
      sustainabilityAnchors: [60],
      dfaValidated: true,
      computeDfa: () => fakeDfa,
      computePowerCurve: () => fakeCurveDelta,
    };

    const dfa = withHooks.computeDfa?.({} as never);
    expect(dfa?.sufficient).toBe(true);
    const delta = withHooks.computePowerCurve?.([] as never);
    expect(delta?.anchorsCovered).toBe(5);
  });

  it("DfaSummary and PowerCurveDeltaSummary are exported and usable", () => {
    const noisy: DfaSummary = { sufficient: false };
    expect(noisy.sufficient).toBe(false);
    const flat: PowerCurveDeltaSummary = { anchorsCovered: 0, trend: "flat" };
    expect(flat.trend).toBe("flat");
  });
});

describe("Sport.referenceAdapters?() integration", () => {
  it("a Sport-shaped slice that omits referenceAdapters still typechecks (optional)", () => {
    // Pick the slice we care about so we don't have to populate every field of
    // Sport just to assert the optionality of one method.
    const sliceWithoutMethod: Pick<Sport, "id" | "referenceAdapters"> = {
      id: "running",
      // referenceAdapters intentionally omitted
    };
    expect(sliceWithoutMethod.referenceAdapters).toBeUndefined();
  });

  it("a Sport-shaped slice can implement referenceAdapters returning a readonly array", () => {
    const adapter: ReferenceSportAdapter = {
      activityTypes: ["Ride"] as const,
      zoneBasis: "power",
      decouplingBasis: "power",
      sustainabilityAnchors: [60],
      dfaValidated: true,
    };
    const sliceWithMethod: Pick<Sport, "id" | "referenceAdapters"> = {
      id: "cycling",
      referenceAdapters: () => [adapter],
    };
    const arr = sliceWithMethod.referenceAdapters?.();
    expect(arr?.length).toBe(1);
    expect(arr?.[0].activityTypes).toEqual(["Ride"]);
  });

  it("composes the duathlon pattern from upstream sports' adapters", () => {
    const cyclingAdapter: ReferenceSportAdapter = {
      activityTypes: ["Ride", "VirtualRide"] as const,
      zoneBasis: "power",
      decouplingBasis: "power",
      sustainabilityAnchors: [60, 120],
      dfaValidated: true,
    };
    const runningAdapter: ReferenceSportAdapter = {
      activityTypes: ["Run", "TrailRun"] as const,
      zoneBasis: "pace",
      decouplingBasis: "pace",
      sustainabilityAnchors: [30, 60],
      dfaValidated: false,
    };

    const cycling: Pick<Sport, "id" | "referenceAdapters"> = {
      id: "cycling",
      referenceAdapters: () => [cyclingAdapter],
    };
    const running: Pick<Sport, "id" | "referenceAdapters"> = {
      id: "running",
      referenceAdapters: () => [runningAdapter],
    };

    // The literal duathlon-composition shape per ADR-0002 + ADR-0010.
    const duathlon: Pick<Sport, "id" | "referenceAdapters"> = {
      id: "duathlon",
      referenceAdapters: () => [
        ...(cycling.referenceAdapters?.() ?? []),
        ...(running.referenceAdapters?.() ?? []),
      ],
    };

    const all = duathlon.referenceAdapters?.() ?? [];
    expect(all.length).toBe(2);
    const allActivityTypes = all.flatMap((a) => [...a.activityTypes]).sort();
    expect(allActivityTypes).toEqual(["Ride", "Run", "TrailRun", "VirtualRide"]);
  });
});
