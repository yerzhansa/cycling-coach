import { describe, it, expect } from "vitest";
import {
  calculateRunningZones,
  ZONE_FRACTIONS,
  LT1_FRACTION_OF_CS,
} from "../src/zones.js";

describe("calculateRunningZones", () => {
  it("returns 6 zones", () => {
    expect(calculateRunningZones(4.0)).toHaveLength(6);
  });

  it("computes the full min/km table for CS 4.0 m/s", () => {
    const zones = calculateRunningZones(4.0, "MINS_KM");

    expect(zones[0]).toEqual({ label: "Z1 Recovery", value: "> 5:47/km" });
    expect(zones[1]).toEqual({ label: "Z2 Easy", value: "5:47-5:04/km" });
    expect(zones[2]).toEqual({ label: "Z3 Moderate", value: "5:04-4:35/km" });
    expect(zones[3]).toEqual({ label: "Z4 Threshold", value: "4:35-4:10/km" });
    expect(zones[4]).toEqual({ label: "Z5 VO2max", value: "4:10-3:43/km" });
    expect(zones[5]).toEqual({ label: "Z6 Anaerobic", value: "< 3:43/km" });
  });

  it("places the two LOCKED boundaries at 0.823*CS and 1.0*CS", () => {
    // The Z2↔Z3 edge is the LT1 boundary (0.823*CS); the Z4↔Z5 edge is CS itself.
    expect(ZONE_FRACTIONS[1].upper).toBe(LT1_FRACTION_OF_CS);
    expect(ZONE_FRACTIONS[2].lower).toBe(LT1_FRACTION_OF_CS);
    expect(ZONE_FRACTIONS[3].upper).toBe(1.0);
    expect(ZONE_FRACTIONS[4].lower).toBe(1.0);
    // CS=4.0 → 0.823*4=3.292 m/s → 1000/3.292=303.8s → 5:04; CS itself → 4:10.
    const zones = calculateRunningZones(4.0, "MINS_KM");
    expect(zones[2].value).toBe("5:04-4:35/km"); // Z3 opens at the LT1 line
    expect(zones[3].value).toBe("4:35-4:10/km"); // Z4 closes at CS
  });

  it("renders min/mi when paceUnits is MINS_MILE", () => {
    const zones = calculateRunningZones(4.0, "MINS_MILE");
    expect(zones[3]).toEqual({ label: "Z4 Threshold", value: "7:22-6:42/mi" });
    expect(zones.every((z) => z.value.endsWith("/mi"))).toBe(true);
  });

  it("defaults to min/km when paceUnits is null/absent", () => {
    const zones = calculateRunningZones(4.0, null);
    expect(zones.every((z) => z.value.endsWith("/km"))).toBe(true);
  });

  it("orders bands slowest→fastest (Z1 uses '> ', Z6 uses '< ')", () => {
    const zones = calculateRunningZones(4.0, "MINS_KM");
    expect(zones[0].value.startsWith("> ")).toBe(true);
    expect(zones[5].value.startsWith("< ")).toBe(true);
  });

  it("threads a lower-boundary override through the Z2/Z3 edge", () => {
    // 0.85*4.0 = 3.4 m/s → 1000/3.4 = 294.1s → 4:54.
    const zones = calculateRunningZones(4.0, "MINS_KM", 0.85);
    expect(zones[1]).toEqual({ label: "Z2 Easy", value: "5:47-4:54/km" });
    expect(zones[2]).toEqual({ label: "Z3 Moderate", value: "4:54-4:35/km" });
  });

  it("sets no overlaps flag on any running band", () => {
    expect(calculateRunningZones(4.0).every((z) => z.overlaps === undefined)).toBe(true);
  });
});
