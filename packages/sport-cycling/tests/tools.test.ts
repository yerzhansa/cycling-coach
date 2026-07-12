import { describe, it, expect, vi } from "vitest";
import { todayInTZ, type MemoryStore } from "@enduragent/core";
import {
  buildPlanSkeletonInputSchema,
  createCyclingTools,
  cyclingCreateWorkoutInputSchema,
} from "../src/tools.js";

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

function createWorkoutTool(intervals: unknown, tz = "UTC") {
  const tools = createCyclingTools({} as MemoryStore, intervals as never, tz);
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

describe("intervals_create_workout provenance", () => {
  it("payload carries external_id 'cycling-coach:<date>:<slug>' and tags ['cycling-coach']", async () => {
    const { client, calls } = fakeIntervals({ ok: true, value: { id: 42 } });
    const tool = createWorkoutTool(client)!;
    const date = tomorrowISODate();

    const out = await tool.execute({ date, workout: validWorkout }, {});

    expect(out).toEqual({ created: true, event: { id: 42 } });
    expect(calls).toHaveLength(1);
    const payload = calls[0];
    expect(payload.external_id).toBe(`cycling-coach:${date}:z2-endurance-90min`);
    expect(payload.tags).toEqual(["cycling-coach"]);
  });

  it("existing fields unchanged: type Ride, category WORKOUT, name, description", async () => {
    const { client, calls } = fakeIntervals({ ok: true, value: { id: 1 } });
    const tool = createWorkoutTool(client)!;

    await tool.execute({ date: tomorrowISODate(), workout: validWorkout }, {});

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

describe("intervals_create_workout payload (calendar-payload group)", () => {
  it("posts Ride, WORKOUT, name, and serialized description without client-derived fields", async () => {
    const { client, calls } = fakeIntervals({ ok: true, value: { id: 42 } });
    const tool = createWorkoutTool(client)!;

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
    const { client, calls } = fakeIntervals({ ok: true, value: { id: 42 } });
    const tool = createWorkoutTool(client)!;
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

  it("returns invalid_workout without calling events.create on a serialization failure", async () => {
    const { client, calls } = fakeIntervals({ ok: true, value: { id: 42 } });
    const tool = createWorkoutTool(client)!;
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

  it("surfaces the API error kind when events.create fails", async () => {
    const { client, calls } = fakeIntervals({
      ok: false,
      error: { kind: "rate_limited" },
    });
    const tool = createWorkoutTool(client)!;

    const result = await tool.execute(
      { date: tomorrowISODate(), workout: validWorkout },
      {},
    );

    expect(result).toEqual({ error: "rate_limited" });
    expect(calls).toHaveLength(1);
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

describe("intervals_create_workout date guard", () => {
  it("allows tomorrow and today", async () => {
    const { client, calls } = fakeIntervals({ ok: true, value: { id: 42 } });
    const tool = createWorkoutTool(client)!;
    expect(
      await tool.execute({ date: tomorrowISODate(), workout: validWorkout }, {}),
    ).toMatchObject({ created: true });
    expect(
      await tool.execute({ date: todayInTZ("UTC"), workout: validWorkout }, {}),
    ).toMatchObject({ created: true });
    expect(calls).toHaveLength(2);
  });

  it("refuses a past date without calling events.create", async () => {
    const { client, calls } = fakeIntervals({ ok: true, value: { id: 42 } });
    const result = await createWorkoutTool(client)!.execute(
      { date: "2020-01-01", workout: validWorkout },
      {},
    );
    expect(result).toMatchObject({ error: "past_date_refused" });
    expect(result.details).toContain("2020-01-01");
    expect(result.details).toContain(todayInTZ("UTC"));
    expect(calls).toHaveLength(0);
  });

  it("refuses an impossible date and rejects non-YYYY-MM-DD schema input", async () => {
    const { client, calls } = fakeIntervals({ ok: true, value: { id: 42 } });
    const result = await createWorkoutTool(client)!.execute(
      { date: "2026-02-31", workout: validWorkout },
      {},
    );
    expect(result).toMatchObject({ error: "invalid_date" });
    expect(calls).toHaveLength(0);
    expect(
      cyclingCreateWorkoutInputSchema.safeParse({ date: "June 15", workout: validWorkout })
        .success,
    ).toBe(false);
  });

  it("uses the constructor timezone for the today boundary", async () => {
    const date = todayInTZ("Pacific/Midway");
    const midway = fakeIntervals({ ok: true, value: { id: 1 } });
    const kiritimati = fakeIntervals({ ok: true, value: { id: 2 } });

    expect(
      await createWorkoutTool(midway.client, "Pacific/Midway")!.execute(
        { date, workout: validWorkout },
        {},
      ),
    ).toMatchObject({ created: true });
    expect(
      await createWorkoutTool(kiritimati.client, "Pacific/Kiritimati")!.execute(
        { date, workout: validWorkout },
        {},
      ),
    ).toMatchObject({ error: "past_date_refused" });
  });
});
