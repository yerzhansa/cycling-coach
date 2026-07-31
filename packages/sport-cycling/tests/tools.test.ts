import { describe, it, expect, vi } from "vitest";
import { asSchema } from "ai";
import type {
  MemoryStorePort as MemoryStore,
  PlatformCalendarMutationsPort,
} from "@enduragent/engine/sport";
import {
  buildPlanSkeletonInputSchema,
  createCyclingTools,
  cyclingCreateWorkoutInputSchema,
} from "../src/tools.js";

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

function futureISODate(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
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

describe("intervals_create_workout payload (calendar-payload group)", () => {
  it("posts Ride, WORKOUT, name, and serialized description without client-derived fields", async () => {
    const { mutations, calls } = fakeMutations();
    const tool = createWorkoutTool(mutations)!;

    await tool.execute({ date: tomorrowISODate(), workout: validWorkout }, {});

    const payload = calls[0];
    expect(payload.type).toBe("Ride");
    expect(payload.category).toBe("WORKOUT");
    expect(payload.name).toBe("Z2 Endurance 90min");
    expect(typeof payload.description).toBe("string");
    expect("moving_time" in payload).toBe(false);
    expect("icu_training_load" in payload).toBe(false);
  });

  it("pushes a zone-ramp workout with translated percent bounds", async () => {
    const { mutations, calls } = fakeMutations();
    const tool = createWorkoutTool(mutations)!;
    const workout = {
      name: "Zone ramp",
      steps: [
        {
          type: "ramp" as const,
          duration: { value: 10, unit: "minutes" as const },
          power: { kind: "zone" as const, low: 1, high: 2 },
        },
      ],
    };

    await tool.execute({ date: tomorrowISODate(), workout }, {});

    expect(calls[0].description).toContain("ramp 45-65%");
  });

  it("returns invalid_workout without calling createEvent on a serialization failure", async () => {
    const { mutations, calls } = fakeMutations();
    const tool = createWorkoutTool(mutations)!;
    const workout = {
      name: "Invalid ramp",
      steps: [
        {
          type: "ramp" as const,
          duration: { value: 10, unit: "minutes" as const },
          power: { kind: "zone" as const, value: 2 },
        },
      ],
    };

    const result = await tool.execute({ date: tomorrowISODate(), workout }, {});

    expect(result).toMatchObject({ error: "invalid_workout" });
    expect(calls).toHaveLength(0);
  });
});

describe("build_plan_skeleton purity", () => {
  it("returns a plan and never calls savePlan", async () => {
    const savePlan = vi.fn();
    const tools = createCyclingTools({ savePlan } as unknown as MemoryStore, null, "UTC");
    const result = await tools.build_plan_skeleton.execute!(
      {
        experienceLevel: "intermediate",
        ftpWatts: 250,
        volumeTier: "medium",
        scheduleType: "flexible",
        goalType: "general",
        generalGoal: "build aerobic base",
      },
      {} as never,
    );

    expect(result).toMatchObject({ phases: expect.any(Array) });
    expect(savePlan).not.toHaveBeenCalled();
  });

  it("description discloses that nothing is saved", () => {
    const tools = createCyclingTools({} as MemoryStore, null, "UTC");
    expect(tools.build_plan_skeleton.description).toContain("Does NOT save anything");
  });
});

describe("build_plan_skeleton raceDate", () => {
  const baseInput = {
    experienceLevel: "intermediate" as const,
    ftpWatts: 250,
    volumeTier: "medium" as const,
    scheduleType: "flexible" as const,
    goalType: "race" as const,
    raceType: "century" as const,
  };

  it("builds a finite plan for a valid future date", async () => {
    const tools = createCyclingTools({} as MemoryStore, null, "UTC");
    const result = (await tools.build_plan_skeleton.execute!(
      { ...baseInput, raceDate: futureISODate(84) },
      {} as never,
    )) as { totalWeeks: number; name: string };
    expect(Number.isFinite(result.totalWeeks)).toBe(true);
    expect(result.name).not.toContain("NaN");
  });

  it("refuses an impossible calendar date", async () => {
    const tools = createCyclingTools({} as MemoryStore, null, "UTC");
    const result = await tools.build_plan_skeleton.execute!(
      { ...baseInput, raceDate: "2026-02-31" },
      {} as never,
    );
    expect(result).toMatchObject({ error: "invalid_date" });
  });

  it("rejects a prose race date at schema level", () => {
    expect(
      buildPlanSkeletonInputSchema.safeParse({ ...baseInput, raceDate: "June 15" }).success,
    ).toBe(false);
  });
});

describe("tool schema portability", () => {
  it("emits plain object schemas without root combinators", async () => {
    const { mutations } = fakeMutations();
    const tools = createCyclingTools({} as MemoryStore, null, "UTC", mutations);
    for (const registered of Object.values(tools)) {
      const schema = (await Promise.resolve(
        asSchema((registered as unknown as { inputSchema: never }).inputSchema).jsonSchema,
      )) as Record<string, unknown>;
      expect(schema.type).toBe("object");
      expect(schema).not.toHaveProperty("anyOf");
      expect(schema).not.toHaveProperty("oneOf");
      expect(schema).not.toHaveProperty("allOf");
    }
  });

  it("rejects a non-YYYY-MM-DD workout date at schema level", () => {
    expect(
      cyclingCreateWorkoutInputSchema.safeParse({ date: "June 15", workout: validWorkout })
        .success,
    ).toBe(false);
  });
});
