import { describe, expect, it } from "vitest";
import { estimateCriticalPower } from "../src/reference/metrics/estimated-cp.js";

describe("Estimated CP formula boundary", () => {
  it("keeps full precision for a valid two-point model", () => {
    expect(
      estimateCriticalPower({
        short: { durationS: 180, averagePowerW: 407 },
        long: { durationS: 900, averagePowerW: 311 },
      }),
    ).toEqual({ status: "available", cpWatts: 287, wPrimeJ: 21_600 });
  });

  it.each([
    [
      { durationS: 0, averagePowerW: 407 },
      { durationS: 900, averagePowerW: 311 },
    ],
    [
      { durationS: 180, averagePowerW: 300 },
      { durationS: 900, averagePowerW: 311 },
    ],
    [
      { durationS: 200, averagePowerW: 800 },
      { durationS: 720, averagePowerW: 200 },
    ],
    [
      { durationS: 900, averagePowerW: 407 },
      { durationS: 180, averagePowerW: 311 },
    ],
  ])("hides mathematically invalid points", (short, long) => {
    expect(estimateCriticalPower({ short, long })).toEqual({
      status: "unavailable",
      reason: "mathematically-invalid",
    });
  });
});
