import type { ProducedLocalBundle } from "@enduragent/kernel/reference/local-bundle";
import type { IntervalsClient } from "intervals-icu-api";
import { describe, expect, it, vi } from "vitest";
import {
  createMissingPlatformCalendarMutations,
  createPlatformAthleteDataReader,
  createPlatformCalendarMutations,
  createStoreAthleteDataReader,
  formatStoreFreshness,
  type PlatformCalendarMutations,
} from "../src/athlete-data.js";
import { createCoreToolsWithSportConfig, createPureCoreIntervalsTools } from "../src/agent/intervals-tools.js";

function produced(frozenNow = "1998-07-18T12:00:00.000Z"): ProducedLocalBundle {
  return {
    captureId: "12345678-1234-4123-8123-123456789abc",
    frozenNow,
    bundle: {
      athlete: { sportSettings: [{ types: ["Ride"], ftp: 250 }] },
      activities: [
        { id: 2, type: "Ride", start_date_local: "1998-07-02T08:00:00", moving_time: 10, elapsed_time: 10 },
        { id: 1, type: "Ride", start_date_local: "1998-07-01T08:00:00", moving_time: 10, elapsed_time: 10 },
      ],
      wellness: [
        { id: "1998-07-01", weight: 70, restingHR: 50, hrv: 60, sleepSecs: 1, sleepQuality: 3 },
        { id: "1998-07-02", weight: 70, restingHR: 50, hrv: 60, sleepSecs: 1, sleepQuality: 3 },
      ],
      ftpHistory: [],
      streams: { "1": { watts: [100, 200], heartrate: [120, 140] } },
    },
  };
}

describe("store athlete reader", () => {
  it("validates real inclusive dates, preserves manifest order, and discloses freshness", async () => {
    const reader = createStoreAthleteDataReader({ snapshot: () => produced(),
      clockNow: () => Date.parse("1998-07-18T12:02:00.000Z") });
    const result = await reader.listActivities({ start: "1998-07-01", end: "1998-07-02" });
    expect(result.ok && result.value.map((row) => (row as { id: number }).id)).toEqual([2, 1]);
    expect(result.ok && formatStoreFreshness(result.freshness!)).toBe(
      "Store data last synchronized 2 minutes ago (1998-07-18T12:00:00.000Z).",
    );
    await expect(reader.listWellness({ start: "1998-02-30" })).resolves.toEqual({
      ok: false, error: "invalid_input",
      message: "Dates must be real YYYY-MM-DD values with start on or before end.",
    });
  });

  it("fails closed for a snapshot more than five minutes in the future", async () => {
    const reader = createStoreAthleteDataReader({ snapshot: () => produced("1998-07-18T12:05:00.001Z"),
      clockNow: () => Date.parse("1998-07-18T12:00:00.000Z") });
    await expect(reader.getAthlete()).resolves.toMatchObject({ ok: false, error: "invalid_snapshot" });
  });

  it("routes every read tool through the selected store reader without touching the platform client", async () => {
    const network = vi.fn(() => { throw new Error("Network disabled for composition test"); });
    const client = {
      athlete: { get: network }, wellness: { list: network },
      activities: { list: network, get: network, getStreams: network },
      events: { list: network, get: network, create: network, delete: network },
    } as unknown as IntervalsClient;
    const reader = createStoreAthleteDataReader({ snapshot: () => produced(),
      clockNow: () => Date.parse("1998-07-18T12:00:30.000Z") });
    const pure = createPureCoreIntervalsTools(client, "UTC", reader, createMissingPlatformCalendarMutations());
    const configured = createCoreToolsWithSportConfig(client, ["Ride"], reader);

    await expect(pure.intervals_fetch_athlete!.execute!({}, {} as never)).resolves.toMatchObject({
      data: { sportSettings: [{ ftp: 250 }] },
      freshness: "Store data last synchronized less than 60 seconds ago (1998-07-18T12:00:00.000Z).",
    });
    await expect(pure.intervals_fetch_wellness!.execute!({ oldest: "1998-07-01", newest: "1998-07-02" }, {} as never))
      .resolves.toMatchObject({ data: [{ id: "1998-07-01" }, { id: "1998-07-02" }] });
    await expect(configured.intervals_fetch_activities!.execute!({ oldest: "1998-07-01", newest: "1998-07-02" }, {} as never))
      .resolves.toMatchObject({ data: [{ id: 2 }, { id: 1 }] });
    await expect(pure.intervals_fetch_activity!.execute!({ activityId: 1 }, {} as never))
      .resolves.toMatchObject({ data: { id: 1 } });
    await expect(pure.intervals_fetch_streams!.execute!({ activityId: 1, types: ["watts"] }, {} as never))
      .resolves.toMatchObject({ data: { channels: { watts: { min: 100, max: 200, mean: 150 } } } });
    await expect(configured.intervals_list_events!.execute!({ oldest: "1998-07-01" }, {} as never))
      .resolves.toEqual({ error: "store_read_unavailable",
        message: "Calendar reads are not available from the local training store." });
    expect(network).not.toHaveBeenCalled();
  });

  it("keeps platform registration names, descriptions, order, and JSON schemas byte-identical", () => {
    const ok = async (value: unknown) => ({ ok: true as const, value });
    const client = {
      athlete: { get: () => ok({}) }, wellness: { list: () => ok([]) },
      activities: { list: () => ok([]), get: () => ok({}), getStreams: () => ok({}) },
      events: { list: () => ok([]), get: () => ok({ id: 1, startDateLocal: "2998-01-01" }),
        create: () => ok({}), delete: () => ok({}) },
    } as unknown as IntervalsClient;
    const signature = (tools: Record<string, { description?: string; inputSchema?: unknown } | undefined>): string =>
      JSON.stringify(Object.entries(tools).map(([name, tool]) => [name, tool?.description, tool?.inputSchema]));
    const directPure = createPureCoreIntervalsTools(client, "UTC");
    const selectedPure = createPureCoreIntervalsTools(client, "UTC",
      createPlatformAthleteDataReader(client), createPlatformCalendarMutations(client));
    expect(signature(selectedPure)).toBe(signature(directPure));
    expect(signature(createCoreToolsWithSportConfig(client, ["Ride"], createPlatformAthleteDataReader(client))))
      .toBe(signature(createCoreToolsWithSportConfig(client, ["Ride"])));
  });

  it("applies strict dates only at store execution and rejects reversed ranges", async () => {
    const reader = createStoreAthleteDataReader({ snapshot: () => produced(),
      clockNow: () => Date.parse("1998-07-18T12:00:00.000Z") });
    const tools = createCoreToolsWithSportConfig(null, ["Ride"], reader);
    await expect(tools.intervals_fetch_activities!.execute!({ oldest: "1998-07-02", newest: "1998-07-01" }, {} as never))
      .resolves.toEqual({ error: "invalid_input",
        message: "Dates must be real YYYY-MM-DD values with start on or before end." });
    expect((tools.intervals_fetch_activities!.inputSchema as { jsonSchema: { properties: { oldest: unknown } } })
      .jsonSchema.properties.oldest).toMatchObject({ type: "string" });
  });

  it("keeps a fresh delete guard read and makes no delete for past or failed GET", async () => {
    const read = vi.fn<PlatformCalendarMutations["readEventForDelete"]>()
      .mockResolvedValue({ id: 7, startDateLocal: "1998-07-01T00:00:00" });
    const remove = vi.fn<PlatformCalendarMutations["deleteEvent"]>().mockResolvedValue({});
    const mutations: PlatformCalendarMutations = { createEvent: vi.fn(), readEventForDelete: read, deleteEvent: remove };
    const tools = createPureCoreIntervalsTools(null, "UTC", undefined, mutations);
    const past = await tools.intervals_delete_workout!.execute!({ eventId: 7 }, {} as never);
    expect(past).toMatchObject({ error: "past_workout_protected" });
    expect(read).toHaveBeenCalledTimes(1); expect(remove).not.toHaveBeenCalled();

    read.mockRejectedValueOnce(new Error("GET failed"));
    await expect(tools.intervals_delete_workout!.execute!({ eventId: 8 }, {} as never)).rejects.toThrow("GET failed");
    expect(remove).not.toHaveBeenCalled();
  });

  it("performs one guard read then one delete for a future workout", async () => {
    const order: string[] = [];
    const mutations: PlatformCalendarMutations = {
      createEvent: vi.fn(),
      readEventForDelete: vi.fn(async () => { order.push("get"); return { id: 7, startDateLocal: "2998-07-01T00:00:00" }; }),
      deleteEvent: vi.fn(async () => { order.push("delete"); return {}; }),
    };
    const tools = createPureCoreIntervalsTools(null, "UTC", undefined, mutations);
    await expect(tools.intervals_delete_workout!.execute!({ eventId: 7 }, {} as never)).resolves.toEqual({ deleted: true });
    expect(order).toEqual(["get", "delete"]);
  });

  it("keeps delete registered with no credentials and performs zero platform requests", async () => {
    const tools = createPureCoreIntervalsTools(null, "UTC", undefined, createMissingPlatformCalendarMutations());
    await expect(tools.intervals_delete_workout!.execute!({ eventId: 7 }, {} as never)).resolves.toEqual({
      error: "platform_credentials_required", message: "Calendar changes need platform credentials.",
    });
  });
});
