import { describe, it, expect } from "vitest";
import type { ReferenceSportAdapter } from "@enduragent/core";
import {
  cyclingReferenceAdapter,
  CYCLING_SUSTAINABILITY_ANCHORS,
  cyclingSport,
} from "../../src/index.js";

describe("cyclingReferenceAdapter declarative fields", () => {
  it("declares the cycling activity types", () => {
    expect(cyclingReferenceAdapter.activityTypes).toEqual(["Ride", "VirtualRide"]);
  });

  it("uses power-based zones and decoupling", () => {
    expect(cyclingReferenceAdapter.zoneBasis).toBe("power");
    expect(cyclingReferenceAdapter.decouplingBasis).toBe("power");
  });

  it("flags DFA as validated for cycling", () => {
    expect(cyclingReferenceAdapter.dfaValidated).toBe(true);
  });

  it("pins sustainability anchors to the seven cycling durations", () => {
    expect(cyclingReferenceAdapter.sustainabilityAnchors).toEqual([
      300, 600, 1200, 1800, 3600, 5400, 7200,
    ]);
    expect(CYCLING_SUSTAINABILITY_ANCHORS).toEqual([
      300, 600, 1200, 1800, 3600, 5400, 7200,
    ]);
    expect(cyclingReferenceAdapter.sustainabilityAnchors).toBe(
      CYCLING_SUSTAINABILITY_ANCHORS,
    );
  });

  it("conforms to the ReferenceSportAdapter contract", () => {
    const typed: ReferenceSportAdapter = cyclingReferenceAdapter;
    expect(typed).toBe(cyclingReferenceAdapter);
  });
});

describe("cyclingReferenceAdapter omits projection hooks", () => {
  it("does not declare computeDfa or computePowerCurve", () => {
    expect(cyclingReferenceAdapter.computeDfa).toBeUndefined();
    expect(cyclingReferenceAdapter.computePowerCurve).toBeUndefined();
  });
});

describe("cyclingSport.referenceAdapters() wiring", () => {
  it("returns a single-element array holding the adapter", () => {
    const adapters = cyclingSport.referenceAdapters?.();
    expect(adapters).toHaveLength(1);
    expect(adapters?.[0]).toBe(cyclingReferenceAdapter);
  });

  it("returns a fresh array on every call", () => {
    const first = cyclingSport.referenceAdapters?.();
    const second = cyclingSport.referenceAdapters?.();
    expect(first).not.toBe(second);
    expect(first?.[0]).toBe(second?.[0]);
  });
});

describe("structural coverage invariants hold for the real adapter", () => {
  it("disjoint coverage: no activity type is claimed twice", () => {
    const adapters = cyclingSport.referenceAdapters?.() ?? [];
    const allTypes = adapters.flatMap((a) => [...a.activityTypes]);
    expect(new Set(allTypes).size).toBe(allTypes.length);
  });

  it("subset coverage: every adapter type is declared by the sport", () => {
    const adapters = cyclingSport.referenceAdapters?.() ?? [];
    const declared = new Set<string>(cyclingSport.intervalsActivityTypes);
    for (const adapter of adapters) {
      for (const type of adapter.activityTypes) {
        expect(declared.has(type)).toBe(true);
      }
    }
  });
});
