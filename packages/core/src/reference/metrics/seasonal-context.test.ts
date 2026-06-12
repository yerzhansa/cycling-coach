import { describe, expect, it } from "vitest";

import { computeSeasonalContext } from "./seasonal-context.js";
import type { MetricInput } from "./metric-input.js";

function inputFor(frozenNow: string): MetricInput {
  return { fixture: {} as MetricInput["fixture"], frozenNow };
}

describe("computeSeasonalContext", () => {
  it("maps November and December to off-season / transition", () => {
    expect(computeSeasonalContext(inputFor("2026-11-15T12:00:00"))).toBe(
      "Off-season / Transition",
    );
    expect(computeSeasonalContext(inputFor("2026-12-31T23:59:59"))).toBe(
      "Off-season / Transition",
    );
  });

  it("maps January and February to early base", () => {
    expect(computeSeasonalContext(inputFor("2026-01-01T00:00:00"))).toBe(
      "Early Base",
    );
    expect(computeSeasonalContext(inputFor("2026-02-28T12:00:00"))).toBe(
      "Early Base",
    );
  });

  it("maps March and April to late base / build", () => {
    expect(computeSeasonalContext(inputFor("2026-03-01T00:00:00"))).toBe(
      "Late Base / Build",
    );
    expect(computeSeasonalContext(inputFor("2026-04-30T23:00:00"))).toBe(
      "Late Base / Build",
    );
  });

  it("maps May and June to build / early race season", () => {
    expect(computeSeasonalContext(inputFor("2026-05-10T12:00:00"))).toBe(
      "Build / Early Race Season",
    );
    expect(computeSeasonalContext(inputFor("2026-06-15T08:00:00"))).toBe(
      "Build / Early Race Season",
    );
  });

  it("maps July and August to peak race season", () => {
    expect(computeSeasonalContext(inputFor("2026-07-04T12:00:00"))).toBe(
      "Peak Race Season",
    );
    expect(computeSeasonalContext(inputFor("2026-08-20T18:00:00"))).toBe(
      "Peak Race Season",
    );
  });

  it("maps September and October to late season / transition", () => {
    expect(computeSeasonalContext(inputFor("2026-09-10T12:00:00"))).toBe(
      "Late Season / Transition",
    );
    expect(computeSeasonalContext(inputFor("2026-10-31T12:00:00"))).toBe(
      "Late Season / Transition",
    );
  });

  it("derives the month from the frozenNow ISO string, not the wall clock", () => {
    // If the implementation used `new Date().getMonth()` this assertion
    // would fail on every month other than the current one. Pinning a
    // frozenNow proves the substitution discipline (datetime.now() ->
    // input.frozenNow) sticks.
    expect(computeSeasonalContext(inputFor("2026-01-15T12:00:00"))).toBe(
      "Early Base",
    );
  });
});
