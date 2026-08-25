import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DecodedFitFile, DecodedRecord } from "@enduragent/kernel/ingest";
import { describe, expect, it } from "vitest";
import { fitCourseRoute, parseFitCourse } from "../src/ingest/fit-course.js";

const fixture = (name: string) => new Uint8Array(readFileSync(resolve(
  "packages/kernel-node/tests/fixtures/ingest",
  name,
)));

function decoded(records: readonly Partial<DecodedRecord>[]): DecodedFitFile {
  return {
    fileIds: [],
    activity: null,
    sessions: [],
    laps: [],
    lengths: [],
    events: [],
    developerDataIds: [],
    records: records.map((record, sourceIndex) => ({
      sourceIndex,
      timestamp: null,
      positionLat: null,
      positionLong: null,
      distance: null,
      enhancedAltitude: null,
      altitude: null,
      enhancedSpeed: null,
      speed: null,
      heartRate: null,
      cadence: null,
      fractionalCadence: null,
      power: null,
      temperature: null,
      stanceTime: null,
      stanceTimeBalance: null,
      verticalOscillation: null,
      verticalRatio: null,
      stepLength: null,
      leftRightBalance: null,
      respirationRate: null,
      developerFields: [],
      coordinateUnit: "degrees",
      ...record,
    })),
  };
}

describe("FIT Race Course adapter", () => {
  it("extracts route-capable records from the committed FIT fixture", async () => {
    const result = await parseFitCourse(fixture("brick-cycling.fit"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.route.format).toBe("fit");
    expect(result.route.segments.flatMap((segment) => segment.points).length).toBeGreaterThan(1);
  });

  it("preserves gaps as segment boundaries and prefers enhanced elevation", () => {
    const result = fitCourseRoute(decoded([
      { positionLat: 43, positionLong: 76, altitude: 900, enhancedAltitude: 905 },
      { positionLat: 43.1, positionLong: 76.1, altitude: 910 },
      {},
      { positionLat: 43.2, positionLong: 76.2 },
    ]));
    expect(result).toEqual({
      ok: true,
      route: {
        format: "fit",
        segments: [
          { points: [
            { latitude: 43, longitude: 76, elevationM: 905 },
            { latitude: 43.1, longitude: 76.1, elevationM: 910 },
          ] },
          { points: [{ latitude: 43.2, longitude: 76.2, elevationM: null }] },
        ],
      },
    });
  });

  it("distinguishes missing route data from invalid route values", () => {
    expect(fitCourseRoute(decoded([{}, {}]))).toEqual({
      ok: false,
      reason: "route-missing",
      detail: "The FIT file does not contain a usable route.",
    });
    expect(fitCourseRoute(decoded([
      { positionLat: 43, positionLong: null },
      { positionLat: 43, positionLong: 77 },
    ]))).toEqual({
      ok: false,
      reason: "unreadable",
      detail: "The FIT route contains invalid values.",
    });
    expect(fitCourseRoute(decoded([
      { positionLat: 91, positionLong: 76 },
      { positionLat: 43, positionLong: 77 },
    ]))).toEqual({
      ok: false,
      reason: "unreadable",
      detail: "The FIT route contains invalid values.",
    });
  });

  it("maps decoder failures to unreadable Course results", async () => {
    const result = await parseFitCourse(new Uint8Array(), {
      decode: async () => {
        throw new Error("decoder unavailable");
      },
    });
    await expect(Promise.resolve(result)).resolves.toEqual({
      ok: false,
      reason: "unreadable",
      detail: "The FIT file could not be read.",
    });
  });
});
