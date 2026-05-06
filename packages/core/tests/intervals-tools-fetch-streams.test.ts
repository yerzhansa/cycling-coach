import { describe, it, expect } from "vitest";
import type { IntervalsClient } from "intervals-icu-api";
import { createPureCoreIntervalsTools } from "../src/agent/intervals-tools.js";

type AnyResult = { ok: true; value: unknown } | { ok: false; error: { kind: string } };

function makeFakeIntervals(
  result: AnyResult,
  capture: { activityId?: string; types?: string[] },
): IntervalsClient {
  const fake = {
    activities: {
      getStreams: async (activityId: string, types: string[]) => {
        capture.activityId = activityId;
        capture.types = types;
        return result;
      },
    },
  };
  return fake as unknown as IntervalsClient;
}

describe("intervals_fetch_streams", () => {
  it("is exported from createPureCoreIntervalsTools", () => {
    const fake = makeFakeIntervals({ ok: true, value: {} }, {});
    const tools = createPureCoreIntervalsTools(fake);
    expect(tools.intervals_fetch_streams).toBeDefined();
  });

  it("calls SDK with default five types when types omitted", async () => {
    const capture: { activityId?: string; types?: string[] } = {};
    const fake = makeFakeIntervals({ ok: true, value: { watts: [] } }, capture);
    const tools = createPureCoreIntervalsTools(fake);
    const tool = tools.intervals_fetch_streams!;

    await tool.execute!({ activityId: 12345 }, {} as never);

    expect(capture.activityId).toBe("12345");
    expect(capture.types).toEqual(["watts", "heartrate", "cadence", "time", "altitude"]);
  });

  it("forwards explicit types verbatim to SDK", async () => {
    const capture: { activityId?: string; types?: string[] } = {};
    const fake = makeFakeIntervals({ ok: true, value: {} }, capture);
    const tools = createPureCoreIntervalsTools(fake);
    const tool = tools.intervals_fetch_streams!;

    await tool.execute!({ activityId: 999, types: ["watts", "heartrate"] }, {} as never);

    expect(capture.types).toEqual(["watts", "heartrate"]);
  });

  it("treats empty types array the same as omitted (uses defaults)", async () => {
    const capture: { activityId?: string; types?: string[] } = {};
    const fake = makeFakeIntervals({ ok: true, value: {} }, capture);
    const tools = createPureCoreIntervalsTools(fake);
    const tool = tools.intervals_fetch_streams!;

    await tool.execute!({ activityId: 1, types: [] }, {} as never);

    expect(capture.types).toEqual(["watts", "heartrate", "cadence", "time", "altitude"]);
  });

  it("returns the stream payload verbatim on success", async () => {
    const streams = { watts: [100, 200, 300], time: [0, 1, 2] };
    const fake = makeFakeIntervals({ ok: true, value: streams }, {});
    const tools = createPureCoreIntervalsTools(fake);
    const tool = tools.intervals_fetch_streams!;

    const result = await tool.execute!({ activityId: 1 }, {} as never);

    expect(result).toEqual(streams);
  });

  it("returns { error: kind } on SDK error", async () => {
    const fake = makeFakeIntervals({ ok: false, error: { kind: "not_found" } }, {});
    const tools = createPureCoreIntervalsTools(fake);
    const tool = tools.intervals_fetch_streams!;

    const result = await tool.execute!({ activityId: 1 }, {} as never);

    expect(result).toEqual({ error: "not_found" });
  });

  it("description carries the cost-warning language", () => {
    const fake = makeFakeIntervals({ ok: true, value: {} }, {});
    const tools = createPureCoreIntervalsTools(fake);
    const description = (tools.intervals_fetch_streams as { description: string }).description;
    expect(description).toContain("EXPENSIVE");
    expect(description).toContain("ONLY call for Tier C");
  });
});
