import { describe, expect, it } from "vitest";
import {
  createCoreToolsWithSportConfig,
  createPureCoreIntervalsTools,
} from "../src/sport/platform-tools.js";
import type { AthleteDataReaderPort } from "../src/host-ports.js";

function fakeReader(calls: string[]): AthleteDataReaderPort {
  const ok = { ok: true as const, value: [] };
  return {
    getAthlete: async () => ({ ok: true, value: {} }),
    listWellness: async () => {
      calls.push("wellness");
      return ok;
    },
    listActivities: async () => {
      calls.push("activities");
      return ok;
    },
    getActivity: async () => ({ ok: true, value: {} }),
    getStreams: async () => ({ ok: true, value: {} }),
    listCalendar: async () => {
      calls.push("events");
      return ok;
    },
    freshness: () => undefined,
  };
}

describe("intervals list range caps", () => {
  it.each([
    ["wellness", "intervals_fetch_wellness"],
    ["activities", "intervals_fetch_activities"],
    ["events", "intervals_list_events"],
  ] as const)("caps %s without calling the reader and passes valid ranges", async (callName, toolName) => {
    const calls: string[] = [];
    const reader = fakeReader(calls);
    const tools = {
      ...createPureCoreIntervalsTools(null, "UTC", reader),
      ...createCoreToolsWithSportConfig(null, ["Ride"], reader),
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
      const reader = fakeReader(calls);
      const tools = {
        ...createPureCoreIntervalsTools(null, "UTC", reader),
        ...createCoreToolsWithSportConfig(null, ["Ride"], reader),
      };
      const result = await tools[toolName]!.execute!(
        { oldest: "2026-06-30", newest: "2026-06-01" },
        {} as never,
      );
      expect(result).toMatchObject({ error: "invalid_range" });
      expect(calls).toEqual([]);
    },
  );

  it.each(["intervals_fetch_wellness", "intervals_fetch_activities", "intervals_list_events"] as const)(
    "refuses an impossible date for %s and rejects prose dates at schema level",
    async (toolName) => {
      const calls: string[] = [];
      const reader = fakeReader(calls);
      const tools = {
        ...createPureCoreIntervalsTools(null, "UTC", reader),
        ...createCoreToolsWithSportConfig(null, ["Ride"], reader),
      };
      const result = await tools[toolName]!.execute!(
        { oldest: "2026-02-31", newest: "2026-03-01" },
        {} as never,
      );
      expect(result).toMatchObject({ error: "invalid_date" });
      expect(calls).toEqual([]);
    },
  );
});
