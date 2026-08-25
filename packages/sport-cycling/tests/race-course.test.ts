import type { CourseRoute } from "@enduragent/kernel/ingest";
import { describe, expect, it } from "vitest";
import {
  CyclingRaceCourseError,
  interpretCyclingRaceCourse,
} from "../src/race-course.js";

function route(elevations: readonly (number | null)[]): CourseRoute {
  return {
    format: "gpx",
    segments: [{
      points: elevations.map((elevationM, index) => ({
        latitude: 0,
        longitude: index,
        elevationM,
      })),
    }],
  };
}

describe("cycling Race Course interpretation", () => {
  it("projects route distance and positive elevation gain", () => {
    const result = interpretCyclingRaceCourse(route([100, 140, 120]));
    expect(result).toMatchObject({
      pointCount: 3,
      elevationGainM: 40,
      elevationStatus: "available",
    });
    expect(result.distanceM).toBeCloseTo(222_390.16, 1);
  });

  it("marks the whole elevation preview unavailable when any route point lacks elevation", () => {
    expect(interpretCyclingRaceCourse(route([100, null, 120]))).toMatchObject({
      pointCount: 3,
      elevationGainM: null,
      elevationStatus: "unavailable",
    });
  });

  it("does not bridge separate route segments", () => {
    const result = interpretCyclingRaceCourse({
      format: "fit",
      segments: [
        { points: [
          { latitude: 0, longitude: 0, elevationM: 0 },
          { latitude: 0, longitude: 1, elevationM: 10 },
        ] },
        { points: [
          { latitude: 0, longitude: 10, elevationM: 100 },
          { latitude: 0, longitude: 11, elevationM: 110 },
        ] },
      ],
    });
    expect(result.distanceM).toBeCloseTo(222_390.16, 1);
    expect(result.elevationGainM).toBe(20);
  });

  it("rejects malformed and point-only routes", () => {
    expect(() => interpretCyclingRaceCourse({
      format: "gpx",
      segments: [{ points: [{ latitude: 0, longitude: 0, elevationM: null }] }],
    })).toThrow(CyclingRaceCourseError);
    expect(() => interpretCyclingRaceCourse({
      format: "gpx",
      segments: [{ points: [
        { latitude: 91, longitude: 0, elevationM: null },
        { latitude: 0, longitude: 1, elevationM: null },
      ] }],
    })).toThrow(CyclingRaceCourseError);
  });
});
