import { createRaceCourseSnapshot } from "@enduragent/kernel/planning";
import { describe, expect, it } from "vitest";
import {
  RaceCourseLifecycleError,
  acceptParsedRaceCourse,
  beginRaceCourseParsing,
  beginRaceCourseRemoval,
  completeRaceCourseRecalculation,
  failRaceCourseRecalculation,
  openRaceCoursePicker,
  rejectRaceCourseFile,
  retryRaceCourseRecalculation,
  useRouteWithoutElevation,
} from "../src/planning/race-course.js";

const route = {
  format: "gpx" as const,
  segments: [{ points: [
    { latitude: 43, longitude: 76, elevationM: 900 },
    { latitude: 43.1, longitude: 76.1, elevationM: 950 },
  ] }],
};

function course(elevation: boolean) {
  return createRaceCourseSnapshot({
    fileName: "almaty.gpx",
    route: elevation ? route : {
      ...route,
      segments: [{ points: route.segments[0]!.points.map((point) => ({
        ...point,
        elevationM: null,
      })) }],
    },
    preview: {
      pointCount: 2,
      distanceM: 13_765,
      elevationGainM: elevation ? 50 : null,
      elevationStatus: elevation ? "available" : "unavailable",
    },
  });
}

describe("Race Course Draft lifecycle", () => {
  it("moves a valid Course through parsing and full-Draft recalculation", () => {
    const oldDraft = { revision: 1, availability: "weekends", ftp: 282 };
    const picker = openRaceCoursePicker({ planStatus: "draft", draft: oldDraft, acceptedCourse: null });
    const parsing = beginRaceCourseParsing(picker, "almaty.gpx");
    expect(parsing.replacing).toBe(false);
    const recalculating = acceptParsedRaceCourse(parsing, course(true));
    expect(recalculating.kind).toBe("course-recalculating");
    if (recalculating.kind !== "course-recalculating") return;
    expect(recalculating.draft).toBe(oldDraft);
    const nextDraft = { revision: 2, availability: "weekends", ftp: 282 };
    const ready = completeRaceCourseRecalculation(recalculating, {
      planStatus: "draft",
      recalculatedDraft: nextDraft,
    });
    expect(ready).toMatchObject({
      kind: "course-ready",
      draft: nextDraft,
      acceptedCourse: { fileName: "almaty.gpx" },
    });
  });

  it("requires an explicit route-only choice when elevation is missing", () => {
    const parsing = beginRaceCourseParsing(openRaceCoursePicker({
      planStatus: "draft",
      draft: { revision: 1 },
      acceptedCourse: null,
    }), "almaty.gpx");
    const missing = acceptParsedRaceCourse(parsing, course(false));
    expect(missing.kind).toBe("course-missing-elevation");
    if (missing.kind !== "course-missing-elevation") return;
    expect(useRouteWithoutElevation(missing)).toMatchObject({
      kind: "course-recalculating",
      candidateCourse: { preview: { elevationStatus: "unavailable" } },
    });
  });

  it("keeps the previous Draft and Course after parse or recalculation failure", () => {
    const oldDraft = { revision: 4 };
    const oldCourse = course(true);
    const parsing = beginRaceCourseParsing(openRaceCoursePicker({
      planStatus: "draft",
      draft: oldDraft,
      acceptedCourse: oldCourse,
    }), "replacement.fit");
    expect(rejectRaceCourseFile(parsing, "No route")).toMatchObject({
      kind: "course-invalid",
      draft: oldDraft,
      acceptedCourse: oldCourse,
    });
    const recalculating = acceptParsedRaceCourse(parsing, course(true));
    if (recalculating.kind !== "course-recalculating") return;
    const failed = failRaceCourseRecalculation(recalculating, "Generation failed");
    expect(failed.draft).toBe(oldDraft);
    expect(failed.acceptedCourse).toBe(oldCourse);
    expect(retryRaceCourseRecalculation(failed)).toMatchObject({
      kind: "course-recalculating",
      draft: oldDraft,
      acceptedCourse: oldCourse,
    });
  });

  it("recalculates removal and commits no Course only after success", () => {
    const oldCourse = course(true);
    const removing = beginRaceCourseRemoval(openRaceCoursePicker({
      planStatus: "draft",
      draft: { revision: 1 },
      acceptedCourse: oldCourse,
    }));
    expect(removing).toMatchObject({ acceptedCourse: oldCourse, candidateCourse: null });
    expect(completeRaceCourseRecalculation(removing, {
      planStatus: "draft",
      recalculatedDraft: { revision: 2 },
    })).toMatchObject({
      kind: "course-ready",
      draft: { revision: 2 },
      acceptedCourse: null,
    });
  });

  it("rejects an in-flight recalculation after the Plan leaves Draft", () => {
    const parsing = beginRaceCourseParsing(openRaceCoursePicker({
      planStatus: "draft",
      draft: { revision: 1 },
      acceptedCourse: null,
    }), "almaty.gpx");
    const recalculating = acceptParsedRaceCourse(parsing, course(true));
    if (recalculating.kind !== "course-recalculating") return;
    for (const planStatus of ["active", "ended"] as const) {
      expect(() => completeRaceCourseRecalculation(recalculating, {
        planStatus,
        recalculatedDraft: { revision: 2 },
      })).toThrow(RaceCourseLifecycleError);
    }
    expect(recalculating).toMatchObject({
      kind: "course-recalculating",
      draft: { revision: 1 },
      acceptedCourse: null,
    });
  });

  it("freezes Course changes once the Plan is active or ended", () => {
    for (const planStatus of ["active", "ended"] as const) {
      expect(() => openRaceCoursePicker({
        planStatus,
        draft: { revision: 1 },
        acceptedCourse: null,
      })).toThrow(RaceCourseLifecycleError);
    }
  });
});
