import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createNodePlanRaceCourseAdapter } from "../src/planning-race-course.js";

const fixtures = resolve(
  import.meta.dirname,
  "..",
  "..",
  "kernel-node",
  "tests",
  "fixtures",
  "ingest",
);

describe("Node Plan Race Course adapter", () => {
  it("normalizes GPX and FIT routes through the dedicated Course path", async () => {
    const adapter = createNodePlanRaceCourseAdapter();
    await expect(adapter.parse(resolve(fixtures, "fallback-cycling.gpx"))).resolves.toMatchObject({
      ok: true,
      course: {
        fileName: "fallback-cycling.gpx",
        format: "gpx",
        preview: { pointCount: expect.any(Number), distanceM: expect.any(Number) },
      },
    });
    await expect(adapter.parse(resolve(fixtures, "brick-cycling.fit"))).resolves.toMatchObject({
      ok: true,
      course: {
        fileName: "brick-cycling.fit",
        format: "fit",
        preview: { pointCount: expect.any(Number), distanceM: expect.any(Number) },
      },
    });
  });

  it("names unsupported and unreadable files without throwing", async () => {
    const adapter = createNodePlanRaceCourseAdapter();
    await expect(
      adapter.parse(resolve(import.meta.dirname, "..", "package.json")),
    ).resolves.toEqual({
      ok: false,
      fileName: "package.json",
      detail: "Choose a GPX or FIT file.",
    });
    await expect(adapter.parse(resolve(fixtures, "missing.gpx"))).resolves.toEqual({
      ok: false,
      fileName: "missing.gpx",
      detail: "This file could not be read as a Race Course.",
    });
  });
});
