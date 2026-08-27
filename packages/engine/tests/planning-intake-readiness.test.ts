import { describe, expect, it } from "vitest";
import { evaluatePlanIntakeReadiness } from "../src/planning/intake-readiness.js";

const complete = {
  eventName: "Gran Fondo Almaty",
  eventPriority: "A" as const,
  eventDateKey: 20261004,
  athleteGoal: "Finish in the front half",
  availabilitySessionsPerWeek: 4,
  availabilityWeekdays: ["tue", "thu", "sat", "sun"],
  experience: "intermediate",
};

describe("Plan intake readiness", () => {
  it("requires every Draft input plus resolved FTP and an explicit Course choice", () => {
    expect(
      evaluatePlanIntakeReadiness({
        intake: undefined,
        ftp: undefined,
        courseChoice: "undecided",
      }),
    ).toEqual({
      ready: false,
      missing: [
        "event",
        "priority",
        "date",
        "goal",
        "availability",
        "experience",
        "ftp",
        "course-choice",
      ],
    });
  });

  it("becomes ready when typed intake, FTP, and Course choice are complete", () => {
    expect(
      evaluatePlanIntakeReadiness({
        intake: complete,
        ftp: {
          manual: { watts: 282, refreshedAtMs: 1 },
          intervalsFtp: null,
          intervalsEftp: null,
          usedSource: "manual",
          usedWatts: 282,
          conflict: false,
        },
        courseChoice: "omitted",
      }),
    ).toEqual({ ready: true, missing: [] });
  });

  it("keeps availability missing until at least one weekday is known", () => {
    expect(
      evaluatePlanIntakeReadiness({
        intake: { ...complete, availabilityWeekdays: [] },
        ftp: {
          manual: { watts: 282, refreshedAtMs: 1 },
          intervalsFtp: null,
          intervalsEftp: null,
          usedSource: "manual",
          usedWatts: 282,
          conflict: false,
        },
        courseChoice: "omitted",
      }),
    ).toEqual({ ready: false, missing: ["availability"] });
  });

  it("keeps an expired or unsupported Goal Event date out of Draft formation", () => {
    const ftp = {
      manual: { watts: 282, refreshedAtMs: 1 },
      intervalsFtp: null,
      intervalsEftp: null,
      usedSource: "manual" as const,
      usedWatts: 282,
      conflict: false,
    };
    expect(
      evaluatePlanIntakeReadiness({
        intake: { ...complete, eventDateKey: 20260822 },
        ftp,
        courseChoice: "omitted",
        minimumEventDateKey: 20260823,
        maximumEventDateKey: 20270206,
      }),
    ).toEqual({ ready: false, missing: ["date"] });
    expect(
      evaluatePlanIntakeReadiness({
        intake: { ...complete, eventDateKey: 20270207 },
        ftp,
        courseChoice: "omitted",
        minimumEventDateKey: 20260823,
        maximumEventDateKey: 20270206,
      }),
    ).toEqual({ ready: false, missing: ["date"] });
  });
});
