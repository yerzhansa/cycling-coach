import { describe, expect, it } from "vitest";
import type { IntervalsActivityType, SportId } from "@enduragent/core";

describe("sport identity unions", () => {
  it("accepts every declared sport id", () => {
    const ids: readonly SportId[] = ["cycling", "running", "duathlon", "swimming", "triathlon"];
    expect(ids).toHaveLength(5);
  });

  it("accepts every declared intervals.icu activity type", () => {
    const types: readonly IntervalsActivityType[] = [
      "Ride",
      "Run",
      "VirtualRide",
      "TrailRun",
      "MountainBikeRide",
      "GravelRide",
      "EBikeRide",
      "Swim",
      "OpenWaterSwim",
      "VirtualRun",
    ];
    expect(types).toHaveLength(10);
  });
});
