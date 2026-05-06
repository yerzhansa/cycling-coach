import { describe, it, expect } from "vitest";
import type { IntervalsClient } from "intervals-icu-api";
import { createPureCoreIntervalsTools } from "../src/agent/intervals-tools.js";

type AnyResult = { ok: true; value: unknown } | { ok: false; error: { kind: string } };

function makeFakeIntervals(getResult: AnyResult, capture: { calledWith?: string }): IntervalsClient {
  const fake = {
    activities: {
      get: async (activityId: string) => {
        capture.calledWith = activityId;
        return getResult;
      },
    },
  };
  return fake as unknown as IntervalsClient;
}

describe("intervals_fetch_activity", () => {
  it("is exported from createPureCoreIntervalsTools", () => {
    const fake = makeFakeIntervals({ ok: true, value: {} }, {});
    const tools = createPureCoreIntervalsTools(fake);
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
    const fake = makeFakeIntervals({ ok: true, value: activity }, capture);
    const tools = createPureCoreIntervalsTools(fake);
    const tool = tools.intervals_fetch_activity!;

    const result = await tool.execute!({ activityId: 12345 }, {} as never);

    expect(result).toEqual(activity);
    expect(capture.calledWith).toBe("12345");
  });

  it("returns { error: kind } on SDK error", async () => {
    const capture: { calledWith?: string } = {};
    const fake = makeFakeIntervals({ ok: false, error: { kind: "not_found" } }, capture);
    const tools = createPureCoreIntervalsTools(fake);
    const tool = tools.intervals_fetch_activity!;

    const result = await tool.execute!({ activityId: 99999 }, {} as never);

    expect(result).toEqual({ error: "not_found" });
  });

  it("description references Tier B+ and key fields", () => {
    const fake = makeFakeIntervals({ ok: true, value: {} }, {});
    const tools = createPureCoreIntervalsTools(fake);
    const description = (tools.intervals_fetch_activity as { description: string }).description;
    expect(description).toMatch(/Tier B\+/);
    expect(description).toMatch(/icu_intervals/);
    expect(description).toMatch(/analyzed/);
    expect(description).toMatch(/paired_event_id/);
  });
});
