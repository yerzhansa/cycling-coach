import { describe, it, expect } from "vitest";
import { asSchema, type FlexibleSchema } from "ai";
import type { AthleteDataReaderPort, AthleteReadResult } from "../src/host-ports.js";
import { createPureCoreIntervalsTools } from "../src/sport/platform-tools.js";

type AnyResult = { ok: true; value: unknown } | { ok: false; error: { kind: string } };

function missing(): Promise<AthleteReadResult<never>> {
  return Promise.resolve({ ok: false, error: "not_found", message: "not found" });
}

async function inputAccepts(schema: unknown, value: unknown): Promise<boolean> {
  const validate = asSchema(schema as FlexibleSchema<unknown>).validate;
  if (validate === undefined) throw new Error("Tool input schema has no validator");
  return (await validate(value)).success;
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

    expect(await inputAccepts(tool.inputSchema, { activityId: 12345 })).toBe(true);
    const result = await tool.execute!({ activityId: 12345 }, {} as never);

    expect(result).toEqual(activity);
    expect(capture.calledWith).toBe("12345");
  });

  it("passes a canonical activity ID to the reader unchanged", async () => {
    const activityId = "a".repeat(64);
    const capture: { calledWith?: string } = {};
    const reader = makeFakeReader({ ok: true, value: { id: activityId, laps: [] } }, capture);
    const tools = createPureCoreIntervalsTools(null, "UTC", reader);
    const tool = tools.intervals_fetch_activity!;

    expect(await inputAccepts(tool.inputSchema, { activityId })).toBe(true);
    await tool.execute!({ activityId }, {} as never);

    expect(capture.calledWith).toBe(activityId);
  });

  it("rejects malformed, non-positive, fractional, and unsafe activity IDs", async () => {
    const reader = makeFakeReader({ ok: true, value: {} }, {});
    const tool = createPureCoreIntervalsTools(null, "UTC", reader).intervals_fetch_activity!;
    const invalidIds = [
      "12345",
      "A".repeat(64),
      "a".repeat(63),
      "not-an-id",
      0,
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
    ];

    for (const activityId of invalidIds) {
      expect(await inputAccepts(tool.inputSchema, { activityId })).toBe(false);
    }
  });

  it("returns { error: kind } on SDK error", async () => {
    const capture: { calledWith?: string } = {};
    const reader = makeFakeReader({ ok: false, error: { kind: "not_found" } }, capture);
    const tools = createPureCoreIntervalsTools(null, "UTC", reader);
    const tool = tools.intervals_fetch_activity!;

    const result = await tool.execute!({ activityId: 99999 }, {} as never);

    expect(result).toEqual({ error: "not_found" });
  });

  it("description documents the bounded canonical summary and laps", () => {
    const reader = makeFakeReader({ ok: true, value: {} }, {});
    const tools = createPureCoreIntervalsTools(null, "UTC", reader);
    const description = (tools.intervals_fetch_activity as { description: string }).description;
    expect(description).toMatch(/Tier B\+/);
    expect(description).toMatch(/bounded source-neutral/i);
    expect(description).toMatch(/summary.*laps/i);
    expect(description).not.toMatch(/icu_intervals|paired_event_id|analyzed/);
  });
});
