import { describe, expect, it } from "vitest";
import {
  RaceCourseSnapshotError,
  createRaceCourseSnapshot,
} from "../src/planning/race-course.js";

const route = {
  format: "gpx" as const,
  segments: [{ points: [
    { latitude: 43, longitude: 76, elevationM: 900 },
    { latitude: 43.1, longitude: 76.1, elevationM: 950 },
  ] }],
};

describe("Race Course snapshot", () => {
  it("copies and deeply freezes normalized route and preview data", () => {
    const snapshot = createRaceCourseSnapshot({
      fileName: "almaty.gpx",
      route,
      preview: {
        pointCount: 2,
        distanceM: 13_765,
        elevationGainM: 50,
        elevationStatus: "available",
      },
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.route.segments)).toBe(true);
    expect(Object.isFrozen(snapshot.route.segments[0]!.points)).toBe(true);
    expect(Object.isFrozen(snapshot.route.segments[0]!.points[0])).toBe(true);
    expect(Object.isFrozen(snapshot.preview)).toBe(true);
    expect(snapshot).toMatchObject({ fileName: "almaty.gpx", format: "gpx" });
  });

  it("rejects mismatched or dishonest previews", () => {
    expect(() => createRaceCourseSnapshot({
      fileName: "almaty.gpx",
      route,
      preview: {
        pointCount: 3,
        distanceM: 13_765,
        elevationGainM: null,
        elevationStatus: "available",
      },
    })).toThrow(RaceCourseSnapshotError);
  });

  it("rejects empty names and malformed routes", () => {
    expect(() => createRaceCourseSnapshot({
      fileName: " ",
      route,
      preview: {
        pointCount: 2,
        distanceM: 13_765,
        elevationGainM: 50,
        elevationStatus: "available",
      },
    })).toThrow(RaceCourseSnapshotError);
    expect(() => createRaceCourseSnapshot({
      fileName: "almaty.gpx",
      route: { format: "gpx", segments: [{ points: [route.segments[0]!.points[0]!] }] },
      preview: {
        pointCount: 1,
        distanceM: 1,
        elevationGainM: null,
        elevationStatus: "unavailable",
      },
    })).toThrow(RaceCourseSnapshotError);
  });
});
