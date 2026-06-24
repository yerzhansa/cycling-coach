import { describe, it, expect } from "vitest";
import { calculateCyclingZones } from "../src/zones.js";

describe("calculateCyclingZones", () => {
  it("returns 6 display rows", () => {
    const zones = calculateCyclingZones(280);
    expect(zones).toHaveLength(6);
  });

  it("calculates correct watt ranges for FTP 280", () => {
    const zones = calculateCyclingZones(280);

    expect(zones[0].label).toBe("Z1 Active Recovery");
    expect(zones[0].value).toBe("< 154W");

    expect(zones[1].label).toBe("Z2 Endurance");
    expect(zones[1].value).toBe("157-210W");

    expect(zones[2].label).toBe("Z3 Tempo");
    expect(zones[2].value).toBe("213-252W");

    expect(zones[3].label).toBe("Sweet Spot (88-94%)");
    expect(zones[3].value).toBe("246-263W");
    expect(zones[3].overlaps).toBe(true);

    expect(zones[4].label).toBe("Z4 Threshold");
    expect(zones[4].value).toBe("255-294W");

    expect(zones[5].label).toBe("Z5 VO2max");
    expect(zones[5].value).toBe("297-336W");
  });

  it("uses 7-zone numbering above tempo: threshold is Z4, sweet spot is a named percent sub-range", () => {
    const zones = calculateCyclingZones(280);

    const threshold = zones.find((z) => /Threshold/.test(z.label));
    expect(threshold?.label).toBe("Z4 Threshold");

    const sweetSpot = zones.find((z) => /Sweet Spot/.test(z.label));
    expect(sweetSpot?.label).toBe("Sweet Spot (88-94%)");
    expect(sweetSpot?.label).not.toMatch(/Z4/);
  });

  it("handles low FTP values", () => {
    const zones = calculateCyclingZones(100);
    expect(zones[0].value).toBe("< 55W");
    expect(zones[1].value).toBe("56-75W");
  });

  it("handles high FTP values", () => {
    const zones = calculateCyclingZones(400);
    expect(zones[4].label).toBe("Z4 Threshold");
    expect(zones[4].value).toBe("364-420W");
  });
});
