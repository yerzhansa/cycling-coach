import { describe, it, expect } from "vitest";
import type { AthleteDataReaderPort, AthleteReadResult } from "../src/host-ports.js";
import { createPureCoreIntervalsTools } from "../src/sport/platform-tools.js";

type AnyResult = { ok: true; value: unknown } | { ok: false; error: { kind: string } };

function missing(): Promise<AthleteReadResult<never>> {
  return Promise.resolve({ ok: false, error: "not_found", message: "not found" });
}

function makeFakeReader(
  getResult: AnyResult,
  capture: { calledWith?: string },
): AthleteDataReaderPort {
  return {
    getAthlete: missing,
    listWellness: missing,
    listActivities: missing,
    getActivity: async ({ id }) => {
      capture.calledWith = id;
      if (!getResult.ok) {
        throw Object.assign(new Error(getResult.error.kind), {
          name: "PlatformApiError",
          apiError: getResult.error,
        });
      }
      return getResult;
    },
    getStreams: missing,
    listCalendar: missing,
    freshness: () => undefined,
  };
}

describe("intervals_fetch_activity", () => {
  it("is exported from createPureCoreIntervalsTools", () => {
    const reader = makeFakeReader({ ok: true, value: {} }, {});
    const tools = createPureCoreIntervalsTools(null, "UTC", reader);
    expect(tools.intervals_fetch_activity).toBeDefined();
  });

  it("returns the activity object verbatim on success", async () => {
    const activity = {
      id: 12345,
      type: "Ride",
      icu_intervals: [{ id: 1, average_watts: 250 }],
      analyzed: "2026-05-01T10:00:00Z",
      paired_event_id: 5000,
    };
    const capture: { calledWith?: string } = {};
    const reader = makeFakeReader({ ok: true, value: activity }, capture);
    const tools = createPureCoreIntervalsTools(null, "UTC", reader);
    const tool = tools.intervals_fetch_activity!;

    const result = await tool.execute!({ activityId: 12345 }, {} as never);

    expect(result).toEqual(activity);
    expect(capture.calledWith).toBe("12345");
  });

  it("returns { error: kind } on SDK error", async () => {
    const capture: { calledWith?: string } = {};
    const reader = makeFakeReader({ ok: false, error: { kind: "not_found" } }, capture);
    const tools = createPureCoreIntervalsTools(null, "UTC", reader);
    const tool = tools.intervals_fetch_activity!;

    const result = await tool.execute!({ activityId: 99999 }, {} as never);

    expect(result).toEqual({ error: "not_found" });
  });

  it("description references Tier B+ and key fields", () => {
    const reader = makeFakeReader({ ok: true, value: {} }, {});
    const tools = createPureCoreIntervalsTools(null, "UTC", reader);
    const description = (tools.intervals_fetch_activity as { description: string }).description;
    expect(description).toMatch(/Tier B\+/);
    expect(description).toMatch(/icu_intervals/);
    expect(description).toMatch(/analyzed/);
    expect(description).toMatch(/paired_event_id/);
  });
});
