import { describe, it, expect } from "vitest";
import type { AthleteDataReaderPort, AthleteReadResult } from "../src/host-ports.js";
import { createPureCoreIntervalsTools } from "../src/sport/platform-tools.js";

type AnyResult = { ok: true; value: unknown } | { ok: false; error: { kind: string } };

function missing(): Promise<AthleteReadResult<never>> {
  return Promise.resolve({ ok: false, error: "not_found", message: "not found" });
}

function makeFakeReader(
  result: AnyResult,
  capture: { activityId?: string; types?: string[] },
): AthleteDataReaderPort {
  return {
    getAthlete: missing,
    listWellness: missing,
    listActivities: missing,
    getActivity: missing,
    getStreams: async ({ id, keys }) => {
      capture.activityId = id;
      capture.types = [...keys];
      if (!result.ok) {
        throw Object.assign(new Error(result.error.kind), {
          name: "PlatformApiError",
          apiError: result.error,
        });
      }
      return result;
    },
    listCalendar: missing,
    freshness: () => undefined,
  };
}

describe("intervals_fetch_streams", () => {
  it("is exported from createPureCoreIntervalsTools", () => {
    const reader = makeFakeReader({ ok: true, value: {} }, {});
    const tools = createPureCoreIntervalsTools(null, "UTC", reader);
    expect(tools.intervals_fetch_streams).toBeDefined();
  });

  it("calls SDK with default five types when types omitted", async () => {
    const capture: { activityId?: string; types?: string[] } = {};
    const reader = makeFakeReader({ ok: true, value: { watts: [] } }, capture);
    const tools = createPureCoreIntervalsTools(null, "UTC", reader);
    const tool = tools.intervals_fetch_streams!;

    await tool.execute!({ activityId: 12345 }, {} as never);

    expect(capture.activityId).toBe("12345");
    expect(capture.types).toEqual(["watts", "heartrate", "cadence", "time", "altitude"]);
  });

  it("forwards explicit types verbatim to SDK", async () => {
    const capture: { activityId?: string; types?: string[] } = {};
    const reader = makeFakeReader({ ok: true, value: {} }, capture);
    const tools = createPureCoreIntervalsTools(null, "UTC", reader);
    const tool = tools.intervals_fetch_streams!;

    await tool.execute!({ activityId: 999, types: ["watts", "heartrate"] }, {} as never);

    expect(capture.types).toEqual(["watts", "heartrate"]);
  });

  it("treats empty types array the same as omitted (uses defaults)", async () => {
    const capture: { activityId?: string; types?: string[] } = {};
    const reader = makeFakeReader({ ok: true, value: {} }, capture);
    const tools = createPureCoreIntervalsTools(null, "UTC", reader);
    const tool = tools.intervals_fetch_streams!;

    await tool.execute!({ activityId: 1, types: [] }, {} as never);

    expect(capture.types).toEqual(["watts", "heartrate", "cadence", "time", "altitude"]);
  });

  it("returns a downsampled stream object on success", async () => {
    const streams = { watts: [100, 200, 300], time: [0, 1, 2] };
    const reader = makeFakeReader({ ok: true, value: streams }, {});
    const tools = createPureCoreIntervalsTools(null, "UTC", reader);
    const tool = tools.intervals_fetch_streams!;

    const result = (await tool.execute!({ activityId: 1 }, {} as never)) as {
      sampleCount: number;
      channels: Record<string, { max: number }>;
    };

    expect(result.sampleCount).toBe(3);
    expect(result.channels.watts.max).toBe(300);
  });

  it("returns { error: kind } on SDK error", async () => {
    const reader = makeFakeReader({ ok: false, error: { kind: "not_found" } }, {});
    const tools = createPureCoreIntervalsTools(null, "UTC", reader);
    const tool = tools.intervals_fetch_streams!;

    const result = await tool.execute!({ activityId: 1 }, {} as never);

    expect(result).toEqual({ error: "not_found" });
  });

  it("description carries the cost-warning language", () => {
    const reader = makeFakeReader({ ok: true, value: {} }, {});
    const tools = createPureCoreIntervalsTools(null, "UTC", reader);
    const description = (tools.intervals_fetch_streams as { description: string }).description;
    expect(description).toContain("EXPENSIVE");
    expect(description).toContain("ONLY call for Tier C");
  });
});
