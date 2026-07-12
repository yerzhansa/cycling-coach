import { describe, expect, it } from "vitest";
import type { IntervalsClient } from "intervals-icu-api";
import {
  createCoreToolsWithSportConfig,
  createPureCoreIntervalsTools,
} from "../src/agent/intervals-tools.js";

function fakeIntervals(calls: string[]): IntervalsClient {
  const ok = { ok: true as const, value: [] };
  return {
    wellness: {
      list: async () => {
        calls.push("wellness");
        return ok;
      },
    },
    activities: {
      list: async () => {
        calls.push("activities");
        return ok;
      },
    },
    events: {
      list: async () => {
        calls.push("events");
        return ok;
      },
    },
  } as unknown as IntervalsClient;
}

describe("intervals list range caps", () => {
  it.each([
    ["wellness", "intervals_fetch_wellness"],
    ["activities", "intervals_fetch_activities"],
    ["events", "intervals_list_events"],
  ] as const)("caps %s without calling the SDK and passes valid ranges", async (callName, toolName) => {
    const calls: string[] = [];
    const intervals = fakeIntervals(calls);
    const tools = {
      ...createPureCoreIntervalsTools(intervals),
      ...createCoreToolsWithSportConfig(intervals, ["Ride"]),
    };
    const execute = tools[toolName]!.execute!;

    const refused = await execute(
      { oldest: "2024-01-01", newest: "2026-01-01" },
      {} as never,
    );
    expect(refused).toMatchObject({ error: "range_too_wide" });
    expect(calls).toEqual([]);

    await execute({ oldest: "2026-06-01", newest: "2026-06-30" }, {} as never);
    expect(calls).toEqual([callName]);
  });

  it.each(["intervals_fetch_wellness", "intervals_fetch_activities", "intervals_list_events"] as const)(
    "refuses swapped bounds for %s",
    async (toolName) => {
      const calls: string[] = [];
      const intervals = fakeIntervals(calls);
      const tools = {
        ...createPureCoreIntervalsTools(intervals),
        ...createCoreToolsWithSportConfig(intervals, ["Ride"]),
      };
      const result = await tools[toolName]!.execute!(
        { oldest: "2026-06-30", newest: "2026-06-01" },
        {} as never,
      );
      expect(result).toMatchObject({ error: "invalid_range" });
      expect(calls).toEqual([]);
    },
  );
});
