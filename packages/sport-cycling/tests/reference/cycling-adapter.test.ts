import { describe, it, expect } from "vitest";
import type { MetricInput, ReferenceSportAdapter } from "@enduragent/core";
import { computeDfaA1Profile, computePowerCurveDelta } from "@enduragent/core";
import {
  cyclingReferenceAdapter,
  CYCLING_SUSTAINABILITY_ANCHORS,
  cyclingSport,
  projectDfaSummary,
  projectPowerCurveDelta,
} from "../../src/index.js";
import { FIXTURE_FROZEN_NOW } from "./fixtures/_helpers/build-cycling-adapter-fixtures.js";

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

// ─── Projection-hook characterization ──────────────────────────────────────
// The projections delegate to the registry computes over a synthetic
// MetricInput. The `{ fixture, frozenNow } as unknown as MetricInput` cast
// matches the established pattern: the registry parses the fixture at the gate
// boundary, so these unit inputs supply only the fields each compute reads.

// One sufficient, steady cycling session: 1800 samples split 600/600/600 across
// dfa_a1 = 1.0 / 0.75 / 0.5 → avg 0.75, validPct 100.
function syntheticDfaStream(): Record<string, unknown> {
  const rep = (v: number, n: number): number[] => Array.from({ length: n }, () => v);
  return {
    dfa_a1: [...rep(1.0, 600), ...rep(0.75, 600), ...rep(0.5, 600)],
    artifacts: rep(0, 1800),
    heartrate: [...rep(138, 600), ...rep(152, 600), ...rep(166, 600)],
    watts: [...rep(175, 600), ...rep(218, 600), ...rep(255, 600)],
  };
}

function dfaInput(streams: Record<string, unknown> | undefined): MetricInput {
  const id = 90207;
  return {
    fixture: {
      activities: [
        {
          id,
          start_date_local: "1998-06-03T07:00:00",
          type: "Ride",
          name: "synthetic-dfa-ride",
          moving_time: 1800,
          elapsed_time: 1800,
        },
      ],
      wellness: [],
      ftp_history: [],
      ...(streams ? { streams: { [String(id)]: streams } } : {}),
    },
    frozenNow: FIXTURE_FROZEN_NOW,
  } as unknown as MetricInput;
}

// Window ids resolved from FIXTURE_FROZEN_NOW (1998-06-04): current = now-27..today,
// previous = now-55..now-28. The projection test MUST pass that exact clock or the
// curve ids will not resolve and the delta collapses to a null block.
const PC_CURRENT_ID = "r.1998-05-08.1998-06-04";
const PC_PREVIOUS_ID = "r.1998-04-10.1998-05-07";

interface PowerCurveEntry {
  id: string;
  secs: number[];
  watts: (number | null)[];
}

function powerInput(list: PowerCurveEntry[] | undefined): MetricInput {
  return {
    fixture: {
      activities: [],
      ...(list ? { power_curves: { list } } : {}),
    },
    frozenNow: FIXTURE_FROZEN_NOW,
  } as unknown as MetricInput;
}

describe("projectDfaSummary", () => {
  it("returns null when no dfa-equipped stream is present", () => {
    expect(projectDfaSummary(dfaInput(undefined))).toBeNull();
  });

  it("projects a sufficient session to { sufficient: true, value }", () => {
    expect(projectDfaSummary(dfaInput(syntheticDfaStream()))).toEqual({
      sufficient: true,
      value: 0.75,
    });
  });

  it("projects an insufficient short session to { sufficient: false } with no value", () => {
    const shortStream = {
      dfa_a1: Array.from({ length: 100 }, () => 0.8),
      artifacts: Array.from({ length: 100 }, () => 0),
    };
    const result = projectDfaSummary(dfaInput(shortStream));
    expect(result).toEqual({ sufficient: false });
    expect(result).not.toHaveProperty("value");
  });

  it("faithfully mirrors latest_session.sufficient (never flips it on a null avg)", () => {
    const shortStream = {
      dfa_a1: Array.from({ length: 100 }, () => 0.8),
      artifacts: Array.from({ length: 100 }, () => 0),
    };
    const profile = computeDfaA1Profile(dfaInput(shortStream));
    expect(profile?.latest_session.sufficient).toBe(false);
    expect(profile?.latest_session.avg).toBeNull();
    expect(projectDfaSummary(dfaInput(shortStream))?.sufficient).toBe(false);
  });
});

describe("projectPowerCurveDelta", () => {
  it("absent curves → { anchorsCovered: 0 }, no trend", () => {
    const result = projectPowerCurveDelta(powerInput(undefined));
    expect(result).toEqual({ anchorsCovered: 0 });
    expect(result).not.toHaveProperty("trend");
  });

  it("full history (5 anchors, current > previous everywhere) → { anchorsCovered: 5, trend: 'up' }", () => {
    const result = projectPowerCurveDelta(
      powerInput([
        { id: PC_CURRENT_ID, secs: [5, 60, 300, 1200, 3600], watts: [1100, 550, 420, 303, 252.5] },
        { id: PC_PREVIOUS_ID, secs: [5, 60, 300, 1200, 3600], watts: [1000, 500, 400, 300, 250] },
      ]),
    );
    expect(result).toEqual({ anchorsCovered: 5, trend: "up" });
  });

  it("flat band (current ≈ previous at all 5 anchors) → { anchorsCovered: 5, trend: 'flat' }", () => {
    const result = projectPowerCurveDelta(
      powerInput([
        { id: PC_CURRENT_ID, secs: [5, 60, 300, 1200, 3600], watts: [1000, 500, 400, 300, 250] },
        { id: PC_PREVIOUS_ID, secs: [5, 60, 300, 1200, 3600], watts: [1000, 500, 400, 300, 250] },
      ]),
    );
    expect(result).toEqual({ anchorsCovered: 5, trend: "flat" });
  });

  it("partial history: ≥3 valid watts per window, only 2 both-side anchors → { anchorsCovered: 2 }, trend undefined", () => {
    const input = powerInput([
      { id: PC_CURRENT_ID, secs: [60, 300, 1200], watts: [550, 420, 303] },
      { id: PC_PREVIOUS_ID, secs: [5, 60, 300], watts: [1000, 500, 400] },
    ]);
    // First assert the rich compute really yields a non-null block with exactly
    // two both-side anchors — the projection's anchorsCovered:2 hinges on it.
    const rich = computePowerCurveDelta(input);
    expect(rich.anchors).not.toBeNull();
    const nonNull = Object.values(rich.anchors ?? {}).filter((a) => a.pct_change !== null);
    expect(nonNull).toHaveLength(2);

    const result = projectPowerCurveDelta(input);
    expect(result).toEqual({ anchorsCovered: 2 });
    expect(result?.trend).toBeUndefined();
  });
});
