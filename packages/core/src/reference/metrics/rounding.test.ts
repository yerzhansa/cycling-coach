import { describe, expect, it } from "vitest";

import { roundHalfEven } from "./rounding.js";

// Reference values are Python `round(x, n)` outputs, captured directly from
// CPython. They are chosen to discriminate the two ways a naive
// implementation fails:
//   - scaled-binary (`Math.round(x*10**n)/10**n` or a decimal lib seeded from
//     the shortest string) gets 0.005 and 0.025 wrong;
//   - naive half-away (`toFixed`) gets the even-tie cases 0.015, 0.125, 0.625,
//     2.675 wrong.
// Passing every row proves agreement with Python's round-half-to-even on the
// *true* IEEE-754 value, which is what the parity gate asserts.
describe("roundHalfEven matches Python round()", () => {
  const twoDp: Array<[number, number]> = [
    [0.005, 0.01], // exact double > 0.005 → up; scaled form gives 0
    [0.015, 0.01], // even-tie down; half-away gives 0.02
    [0.025, 0.03], // exact double > 0.025 → up; scaled form gives 0.02
    [0.045, 0.04], // even-tie down; half-away gives 0.05
    [0.125, 0.12], // exact tie, floor even → down; half-away gives 0.13
    [0.135, 0.14],
    [0.375, 0.38],
    [0.625, 0.62], // exact tie, floor even → down; half-away gives 0.63
    [0.875, 0.88],
    [2.675, 2.67], // even-tie down; half-away gives 2.68
  ];

  const oneDp: Array<[number, number]> = [
    [0.05, 0.1],
    [0.15, 0.1], // even-tie down
    [0.25, 0.2], // even-tie down
    [0.35, 0.3], // even-tie down
    [0.45, 0.5],
    [2.85, 2.9],
    [2.95, 3.0],
    [28.75, 28.8],
  ];

  const zeroDp: Array<[number, number]> = [
    [0.5, 0],
    [1.5, 2],
    [2.5, 2], // even-tie down
    [3.5, 4],
  ];

  it.each(twoDp)("round(%f, 2) === %f", (value, expected) => {
    expect(roundHalfEven(value, 2)).toBe(expected);
  });

  it.each(oneDp)("round(%f, 1) === %f", (value, expected) => {
    expect(roundHalfEven(value, 1)).toBe(expected);
  });

  it.each(zeroDp)("round(%f, 0) === %f", (value, expected) => {
    expect(roundHalfEven(value, 0)).toBe(expected);
  });

  it("rounds the true value, not the base-10 scaling (regression for the F8/F9 bug)", () => {
    // 18s / 3600 = 0.005 h. The scaled form computed 0.005*100 = 0.4999…94 and
    // rounded to 0, dropping the bin; Python keeps it at 0.01.
    expect(roundHalfEven(18 / 3600, 2)).toBe(0.01);
    expect(roundHalfEven(90 / 3600, 2)).toBe(0.03);
  });

  it("handles sign, zero, and non-finite inputs like Python", () => {
    expect(roundHalfEven(-0.125, 2)).toBe(-0.12);
    expect(roundHalfEven(-2.5, 0)).toBe(-2);
    expect(roundHalfEven(0, 2)).toBe(0);
    expect(roundHalfEven(Number.NaN, 2)).toBeNaN();
    expect(roundHalfEven(Number.POSITIVE_INFINITY, 2)).toBe(Number.POSITIVE_INFINITY);
  });
});
