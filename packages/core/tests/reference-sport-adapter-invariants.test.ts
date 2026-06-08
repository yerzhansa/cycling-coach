import { describe, it, expect } from "vitest";
import type { ReferenceSportAdapter } from "../src/reference/sport-adapter.js";
import type { IntervalsActivityType } from "../src/sport.js";
import {
  assertDisjointCoverage,
  assertSubsetCoverage,
} from "../src/reference/sport-adapter-invariants.js";
import { ReferenceConfigError } from "../src/reference/errors.js";
import { ReferenceConfigError as ReferenceConfigErrorFromBarrel } from "../src/index.js";

const cyclingAdapter: ReferenceSportAdapter = {
  activityTypes: ["Ride", "VirtualRide"],
  zoneBasis: "power",
  decouplingBasis: "power",
  sustainabilityAnchors: [300, 1200, 3600],
  dfaValidated: true,
};

const runningAdapter: ReferenceSportAdapter = {
  activityTypes: ["Run", "TrailRun"],
  zoneBasis: "pace",
  decouplingBasis: "pace",
  sustainabilityAnchors: [60, 300],
  dfaValidated: false,
};

describe("ReferenceConfigError", () => {
  it("is an Error subclass with the expected name, identical at module and barrel", () => {
    const err = new ReferenceConfigError("boom");
    expect(err).toBeInstanceOf(ReferenceConfigError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ReferenceConfigError");
    expect(ReferenceConfigErrorFromBarrel).toBe(ReferenceConfigError);
  });
});

describe("assertDisjointCoverage", () => {
  it("does not throw when adapters claim disjoint types", () => {
    expect(() => assertDisjointCoverage([cyclingAdapter, runningAdapter])).not.toThrow();
  });

  it("does not throw for an empty adapter array", () => {
    expect(() => assertDisjointCoverage([])).not.toThrow();
  });

  it("throws naming both offending adapters by identity, never by array index", () => {
    const overlapA: ReferenceSportAdapter = {
      activityTypes: ["Ride"],
      zoneBasis: "power",
      decouplingBasis: "power",
      sustainabilityAnchors: [300],
      dfaValidated: true,
    };
    const overlapB: ReferenceSportAdapter = {
      activityTypes: ["Ride", "VirtualRide"],
      zoneBasis: "power",
      decouplingBasis: "power",
      sustainabilityAnchors: [600],
      dfaValidated: true,
    };
    let caught: unknown;
    try {
      assertDisjointCoverage([overlapA, overlapB]);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ReferenceConfigError);
    const message = (caught as Error).message;
    expect(message).toContain("adapter[Ride]");
    expect(message).toContain("adapter[Ride,VirtualRide]");
    expect(message).not.toContain("index ");
  });
});

describe("assertSubsetCoverage", () => {
  const cyclingTypes: readonly IntervalsActivityType[] = ["Ride", "VirtualRide"];

  it("does not throw when the union of declared types is a subset", () => {
    expect(() => assertSubsetCoverage([cyclingAdapter], cyclingTypes)).not.toThrow();
  });

  it("does not throw for an empty adapter array", () => {
    expect(() => assertSubsetCoverage([], cyclingTypes)).not.toThrow();
  });

  it("throws naming the stray type and the owning adapter identity", () => {
    const strayAdapter: ReferenceSportAdapter = {
      activityTypes: ["Ride", "GravelRide"] as unknown as readonly IntervalsActivityType[],
      zoneBasis: "power",
      decouplingBasis: "power",
      sustainabilityAnchors: [300],
      dfaValidated: true,
    };
    let caught: unknown;
    try {
      assertSubsetCoverage([strayAdapter], cyclingTypes);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ReferenceConfigError);
    const message = (caught as Error).message;
    expect(message).toContain("GravelRide");
    expect(message).toContain("adapter[Ride,GravelRide]");
  });
});
