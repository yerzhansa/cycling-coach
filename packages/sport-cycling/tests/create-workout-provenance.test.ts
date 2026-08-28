import { describe, it, expect } from "vitest";
import type {
  MemoryStorePort as MemoryStore,
  PlatformCalendarMutationsPort,
} from "@enduragent/engine/sport";
import { createCyclingTools } from "../src/tools.js";

function fakeMutations(event: unknown = { id: 42 }): {
  mutations: PlatformCalendarMutationsPort;
  calls: Record<string, unknown>[];
} {
  const calls: Record<string, unknown>[] = [];
  const mutations: PlatformCalendarMutationsPort = {
    createEvent: async (payload) => {
      calls.push(payload as Record<string, unknown>);
      return event;
    },
    readEventForDelete: async ({ eventId }) => ({ id: eventId, startDateLocal: "2999-01-01" }),
    updateEvent: async () => ({}),
    deleteEvent: async () => ({}),
  };
  return { mutations, calls };
}

function createWorkoutTool(mutations: PlatformCalendarMutationsPort, tz = "UTC") {
  const tools = createCyclingTools({} as MemoryStore, null, tz, mutations);
  return (tools as Record<string, unknown>).intervals_create_workout as
    | { execute: (input: unknown, opts: unknown) => Promise<Record<string, unknown>> }
    | undefined;
}

function tomorrowISODate(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

const validWorkout = {
  name: "Z2 Endurance 90min",
  steps: [
    {
      type: "steady" as const,
      duration: { value: 70, unit: "minutes" as const },
      power: { kind: "percent_ftp" as const, low: 56, high: 75 },
    },
  ],
};

describe("intervals_create_workout provenance", () => {
  it("payload carries externalId 'cycling-coach:<date>:<slug>' and tags ['cycling-coach']", async () => {
    const { mutations, calls } = fakeMutations();
    const tool = createWorkoutTool(mutations)!;
    const date = tomorrowISODate();

    const out = await tool.execute({ date, workout: validWorkout }, {});

    expect(out).toEqual({ created: true, event: { id: 42 } });
    expect(calls).toHaveLength(1);
    const payload = calls[0];
    expect(payload.externalId).toBe(`cycling-coach:${date}:z2-endurance-90min`);
    expect(payload.external_id).toBeUndefined();
    expect(payload.tags).toEqual(["cycling-coach"]);
  });

  it("existing fields unchanged: type Ride, category WORKOUT, name, description", async () => {
    const { mutations, calls } = fakeMutations({ id: 1 });
    const tool = createWorkoutTool(mutations)!;

    await tool.execute({ date: tomorrowISODate(), workout: validWorkout }, {});

    const payload = calls[0];
    expect(payload.type).toBe("Ride");
    expect(payload.category).toBe("WORKOUT");
    expect(payload.name).toBe("Z2 Endurance 90min");
    expect(typeof payload.description).toBe("string");
  });

  it("tool absent when no calendar mutations port is configured", () => {
    const tools = createCyclingTools({} as MemoryStore, null, "UTC");
    expect("intervals_create_workout" in tools).toBe(false);
  });
});
