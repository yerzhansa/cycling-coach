import { describe, expect, it } from "vitest";
import { QUALITY_RANK, assertQualityRank, qualityRankForFile } from "../../src/ingest/quality-rank.js";

describe("quality rank", () => {
  it("exports the exact ordered ladder", () => {
    expect(QUALITY_RANK).toEqual({ GPX: 100, TCX: 200, PLATFORM_API: 300, FIT: 400 });
    expect(Object.keys(QUALITY_RANK)).toEqual(["GPX", "TCX", "PLATFORM_API", "FIT"]);
    expect(Object.values(QUALITY_RANK).map(assertQualityRank)).toEqual([100, 200, 300, 400]);
  });

  it("rejects every representative unknown rank", () => {
    for (const value of [-1, 0, 99, 101, 300.5, 401, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => assertQualityRank(value)).toThrow(RangeError);
    }
  });

  it("maps file formats", () => {
    expect(qualityRankForFile("gpx")).toBe(100);
    expect(qualityRankForFile("tcx")).toBe(200);
    expect(qualityRankForFile("fit")).toBe(400);
  });
});
