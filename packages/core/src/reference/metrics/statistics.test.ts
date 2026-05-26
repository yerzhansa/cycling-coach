import { describe, expect, it } from "vitest";

import { roundHalfEven } from "./rounding.js";
import { mean, pythonSum, sampleStdev } from "./statistics.js";

// Reference values are CPython 3.10 `statistics.mean` / `statistics.stdev`
// outputs, captured directly (3.10 is the snapshot oracle). They are chosen
// to discriminate the exact-rational path from a naive float `sum/n` +
// two-pass stdev: the floats agree to many digits but diverge in the last
// ULPs, and that drift can flip the final `round(_, 2)` at a boundary.
describe("mean matches CPython statistics.mean", () => {
  const cases: Array<[number[], number]> = [
    [[21.2, 154.3, 268.1, 122.0, 34.6, 33.1, 231.2], 123.5],
    [[0.1, 0.2, 0.3], 0.2],
    [[50, 50, 50, 50, 50, 50, 55], 50.714285714285715],
    [[60, 0, 0, 90, 0, 0, 120], 38.57142857142857],
    [[48.5, 52.3, 49.9, 51.1, 50.0, 47.7, 53.2], 50.385714285714286],
    [[100.0, 100.1, 99.9, 100.2, 99.8, 100.05, 99.95], 100.0],
    [[42.5], 42.5],
  ];

  it.each(cases)("mean(%j) === %f", (values, expected) => {
    expect(mean(values)).toBe(expected);
  });
});

describe("sampleStdev matches CPython statistics.stdev", () => {
  const cases: Array<[number[], number]> = [
    [[21.2, 154.3, 268.1, 122.0, 34.6, 33.1, 231.2], 100.0],
    [[0.1, 0.2, 0.3], 0.09999999999999999],
    [[50, 50, 50, 50, 50, 50, 55], 1.889822365046136],
    [[60, 0, 0, 90, 0, 0, 120], 51.1300861947808],
    [[48.5, 52.3, 49.9, 51.1, 50.0, 47.7, 53.2], 1.9684414913229968],
    [[100.0, 100.1, 99.9, 100.2, 99.8, 100.05, 99.95], 0.13228756555322918],
  ];

  it.each(cases)("stdev(%j) === %f", (values, expected) => {
    expect(sampleStdev(values)).toBe(expected);
  });
});

describe("pythonSum matches CPython 3.12+ sum() (Neumaier)", () => {
  it("compensates like the builtin, not naive left-to-right", () => {
    // CPython 3.12+ `sum()` uses Neumaier compensated summation. This daily-
    // load array sums to exactly 525.0 under the oracle; a naive reduce gives
    // 524.9999999999999, which flips round(525 × 0.62, 0) from 326 to 325.
    const daily = [0, 0, 9.7, 266.4, 239.5, 9.4, 0];
    expect(pythonSum(daily)).toBe(525);
    expect(daily.reduce((s, t) => s + t, 0)).toBe(524.9999999999999); // the bug
  });

  it("equals exact sums where naive accumulation also would", () => {
    expect(pythonSum([])).toBe(0);
    expect(pythonSum([90, 0, 120, 0, 0, 75, 0])).toBe(285);
  });
});

describe("monotony boundary regression (exact-vs-float drift)", () => {
  it("rounds at the 2-dp boundary on the true mean/stdev, not the float ones", () => {
    // Daily loads where the exact mean (123.5) and exact stdev (100.0) give
    // a ratio of exactly 1.235 → Python round-half-to-even = 1.24. A naive
    // float sum/n + two-pass stdev nudged the ratio just under 1.235 and
    // rounded to 1.23 — the deleted helpers' bug. This is the case the three
    // tidy golden fixtures could never surface (~1 in 2M random vectors).
    const loads = [21.2, 154.3, 268.1, 122.0, 34.6, 33.1, 231.2];
    const m = mean(loads);
    const s = sampleStdev(loads);
    expect(m).toBe(123.5);
    expect(s).toBe(100.0);
    expect(roundHalfEven(m / s, 2)).toBe(1.24);
  });
});
