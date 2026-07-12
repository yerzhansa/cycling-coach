import { describe, it, expect } from "vitest";
import type { MemoryStore } from "@enduragent/core";
import { createCyclingTools } from "../src/tools.js";

type CreateResult =
  | { ok: true; value: { id: number } }
  | { ok: false; error: { kind: string } };

function fakeIntervals(
  result: CreateResult,
): { client: unknown; calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  const client = {
    events: {
      create: async (payload: Record<string, unknown>) => {
        calls.push(payload);
        return result;
      },
    },
  };
  return { client, calls };
}

function createWorkoutTool(intervals: unknown) {
  const tools = createCyclingTools({} as MemoryStore, intervals as never, "UTC");
  return (tools as Record<string, unknown>).intervals_create_workout as
    | { execute: (input: unknown, opts: unknown) => Promise<Record<string, unknown>> }
    | undefined;
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
  it("payload carries external_id 'cycling-coach:<date>:<slug>' and tags ['cycling-coach']", async () => {
    const { client, calls } = fakeIntervals({ ok: true, value: { id: 42 } });
    const tool = createWorkoutTool(client)!;

    const out = await tool.execute({ date: "2026-06-21", workout: validWorkout }, {});

    expect(out).toEqual({ created: true, event: { id: 42 } });
    expect(calls).toHaveLength(1);
    const payload = calls[0];
    expect(payload.external_id).toBe("cycling-coach:2026-06-21:z2-endurance-90min");
    expect(payload.tags).toEqual(["cycling-coach"]);
  });

  it("existing fields unchanged: type Ride, category WORKOUT, name, description", async () => {
    const { client, calls } = fakeIntervals({ ok: true, value: { id: 1 } });
    const tool = createWorkoutTool(client)!;

    await tool.execute({ date: "2026-06-21", workout: validWorkout }, {});

    const payload = calls[0];
    expect(payload.type).toBe("Ride");
    expect(payload.category).toBe("WORKOUT");
    expect(payload.name).toBe("Z2 Endurance 90min");
    expect(typeof payload.description).toBe("string");
  });

  it("tool absent when no intervals client configured", () => {
    const tools = createCyclingTools({} as MemoryStore, null, "UTC");
    expect("intervals_create_workout" in tools).toBe(false);
  });
});
