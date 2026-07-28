import { describe, expect, it } from "vitest";
import {
  COACH_EVENT_TAG,
  COACH_EXTERNAL_ID_PREFIX,
  buildCoachExternalId,
  isCoachOwnedEvent,
} from "../src/agent/event-provenance.js";
import {
  createPureCoreIntervalsTools,
  createCoreToolsWithSportConfig,
} from "../src/agent/intervals-tools.js";
import { todayInTZ } from "../src/agent/user-time.js";
import type { IntervalsClient } from "intervals-icu-api";

type EventKnobs = {
  id?: number;
  startDateLocal?: string;
  category?: string | null;
  omitCategory?: boolean;
  tags?: string[] | null;
  externalId?: string | null;
  name?: string | null;
};

function makeDeleteFake(event: EventKnobs): {
  client: IntervalsClient;
  deleteCalls: number[];
} {
  const deleteCalls: number[] = [];
  const fake = {
    events: {
      get: async (id: number) => ({
        ok: true,
        value: {
          id,
          startDateLocal: event.startDateLocal ?? "2999-01-01T00:00:00",
          ...(event.omitCategory
            ? {}
            : {
                category:
                  event.category === undefined ? "WORKOUT" : event.category,
              }),
          tags: event.tags,
          externalId: event.externalId,
          name: event.name,
        },
      }),
      delete: async (id: number) => {
        deleteCalls.push(id);
        return { ok: true };
      },
    },
  };
  return { client: fake as unknown as IntervalsClient, deleteCalls };
}

function makeListFake(events: EventKnobs[]): IntervalsClient {
  const fake = {
    events: {
      list: async () => ({
        ok: true,
        value: events.map((e, i) => ({
          id: e.id ?? i + 1,
          startDateLocal: e.startDateLocal ?? "2999-01-01T00:00:00",
          name: e.name ?? null,
          movingTime: 3600,
          icuTrainingLoad: 50,
          category: e.category === undefined ? "WORKOUT" : e.category,
          tags: e.tags,
          externalId: e.externalId,
        })),
      }),
    },
  };
  return fake as unknown as IntervalsClient;
}

type DeleteResult = { deleted?: true; error?: string; details?: string };

async function runDelete(event: EventKnobs, tz = "UTC") {
  const { client, deleteCalls } = makeDeleteFake(event);
  const tools = createPureCoreIntervalsTools(client, tz);
  const result = (await tools.intervals_delete_workout!.execute!(
    { eventId: event.id ?? 1 },
    {} as never,
  )) as DeleteResult;
  return { result, deleteCalls };
}

type StrengthCreateResult =
  | { ok: true; value: { id: number } }
  | {
      ok: false;
      error: { kind: string; status?: number; message?: string };
    };

function makeStrengthCreateFake(result: StrengthCreateResult): {
  client: IntervalsClient;
  createCalls: Record<string, unknown>[];
} {
  const createCalls: Record<string, unknown>[] = [];
  const fake = {
    events: {
      create: async (payload: Record<string, unknown>) => {
        createCalls.push(payload);
        return result;
      },
    },
  };
  return {
    client: fake as unknown as IntervalsClient,
    createCalls,
  };
}

async function runStrengthCreate(
  client: IntervalsClient,
  date: string,
  tz = "UTC",
) {
  const tools = createPureCoreIntervalsTools(client, tz);
  return tools.intervals_create_strength_workout!.execute!(
    {
      date,
      name: "Lower body 45min",
      description: "Back squat 3x5 @ RPE 7",
    },
    {} as never,
  );
}

describe("event provenance helpers", () => {
  it("buildCoachExternalId formats prefix:date:slug", () => {
    expect(buildCoachExternalId("2026-05-01", "Threshold 3x10")).toBe(
      `${COACH_EXTERNAL_ID_PREFIX}2026-05-01:threshold-3x10`,
    );
  });

  it("slugs unicode/emoji/whitespace names, caps at 40 chars, falls back to 'workout'", () => {
    expect(buildCoachExternalId("2026-05-01", "  Café  Ride! 🚴 ")).toBe(
      `${COACH_EXTERNAL_ID_PREFIX}2026-05-01:caf-ride`,
    );
    const long = "a".repeat(60);
    const built = buildCoachExternalId("2026-05-01", long);
    const slug = built.slice(`${COACH_EXTERNAL_ID_PREFIX}2026-05-01:`.length);
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(buildCoachExternalId("2026-05-01", "🚴🚴🚴")).toBe(
      `${COACH_EXTERNAL_ID_PREFIX}2026-05-01:workout`,
    );
    expect(buildCoachExternalId("2026-05-01", "")).toBe(
      `${COACH_EXTERNAL_ID_PREFIX}2026-05-01:workout`,
    );
  });

  it("isCoachOwnedEvent: coach tag alone matches", () => {
    expect(isCoachOwnedEvent({ tags: [COACH_EVENT_TAG] })).toBe(true);
  });

  it("isCoachOwnedEvent: externalId prefix alone matches", () => {
    expect(isCoachOwnedEvent({ externalId: `${COACH_EXTERNAL_ID_PREFIX}2026-05-01:x` })).toBe(true);
  });

  it("isCoachOwnedEvent: neither -> false; null/undefined tags and externalId -> false", () => {
    expect(isCoachOwnedEvent({})).toBe(false);
    expect(isCoachOwnedEvent({ tags: null, externalId: null })).toBe(false);
    expect(isCoachOwnedEvent({ tags: [], externalId: undefined })).toBe(false);
    expect(isCoachOwnedEvent({ tags: ["other"] })).toBe(false);
  });

  it("rejects near-miss forgeries: tag 'cycling-coach-pro', externalId 'evil-cycling-coach:...'", () => {
    expect(isCoachOwnedEvent({ tags: ["cycling-coach-pro"] })).toBe(false);
    expect(isCoachOwnedEvent({ externalId: "evil-cycling-coach:2026-05-01:x" })).toBe(false);
  });
});

describe("intervals_create_strength_workout", () => {
  it("posts a provenance-marked WeightTraining workout and returns the event", async () => {
    const event = { id: 42 };
    const { client, createCalls } = makeStrengthCreateFake({
      ok: true,
      value: event,
    });
    const date = todayInTZ("UTC");

    await expect(runStrengthCreate(client, date)).resolves.toEqual({
      created: true,
      event,
    });
    expect(createCalls).toEqual([
      {
        start_date_local: `${date}T00:00:00`,
        category: "WORKOUT",
        name: "Lower body 45min",
        type: "WeightTraining",
        external_id: `cycling-coach:${date}:strength-lower-body-45min`,
        tags: ["cycling-coach"],
        description: "Back squat 3x5 @ RPE 7",
      },
    ]);
  });

  it("refuses a past date without calling events.create", async () => {
    const { client, createCalls } = makeStrengthCreateFake({
      ok: true,
      value: { id: 1 },
    });

    await expect(runStrengthCreate(client, "2020-01-01")).resolves.toMatchObject({
      error: "past_date_refused",
    });
    expect(createCalls).toEqual([]);
  });

  it("refuses an impossible date without calling events.create", async () => {
    const { client, createCalls } = makeStrengthCreateFake({
      ok: true,
      value: { id: 1 },
    });

    await expect(runStrengthCreate(client, "2026-02-31")).resolves.toMatchObject({
      error: "invalid_date",
    });
    expect(createCalls).toEqual([]);
  });

  it("surfaces a typed API error after one events.create call", async () => {
    const { client, createCalls } = makeStrengthCreateFake({
      ok: false,
      error: {
        kind: "rate_limited",
        status: 429,
        message: "Slow down",
      },
    });

    await expect(
      runStrengthCreate(client, todayInTZ("UTC")),
    ).resolves.toEqual({
      error: "rate_limited",
      status: 429,
      message: "Slow down",
    });
    expect(createCalls).toHaveLength(1);
  });

  it("uses the constructor timezone for the today boundary", async () => {
    const date = todayInTZ("Pacific/Midway");
    const midway = makeStrengthCreateFake({
      ok: true,
      value: { id: 1 },
    });
    const kiritimati = makeStrengthCreateFake({
      ok: true,
      value: { id: 2 },
    });

    await expect(
      runStrengthCreate(midway.client, date, "Pacific/Midway"),
    ).resolves.toMatchObject({ created: true });
    await expect(
      runStrengthCreate(kiritimati.client, date, "Pacific/Kiritimati"),
    ).resolves.toMatchObject({ error: "past_date_refused" });
    expect(midway.createCalls).toHaveLength(1);
    expect(kiritimati.createCalls).toEqual([]);
  });
});

describe("intervals_delete_workout guards", () => {
  it("refuses category RACE_A with not_a_workout; delete not called", async () => {
    const { result, deleteCalls } = await runDelete({
      category: "RACE_A",
      tags: [COACH_EVENT_TAG],
    });
    expect(result.error).toBe("not_a_workout");
    expect(deleteCalls).toEqual([]);
  });

  it("refuses category NOTE with not_a_workout; delete not called", async () => {
    const { result, deleteCalls } = await runDelete({
      category: "NOTE",
      tags: [COACH_EVENT_TAG],
    });
    expect(result.error).toBe("not_a_workout");
    expect(deleteCalls).toEqual([]);
  });

  it("refuses missing category (undefined) with not_a_workout", async () => {
    const { result, deleteCalls } = await runDelete({
      omitCategory: true,
      tags: [COACH_EVENT_TAG],
    });
    expect(result.error).toBe("not_a_workout");
    expect(deleteCalls).toEqual([]);
  });

  it("refuses null category with not_a_workout", async () => {
    const { result, deleteCalls } = await runDelete({
      category: null,
      tags: [COACH_EVENT_TAG],
    });
    expect(result.error).toBe("not_a_workout");
    expect(deleteCalls).toEqual([]);
  });

  it("refuses unmarked WORKOUT with not_coach_created; delete not called; details mention intervals.icu", async () => {
    const { result, deleteCalls } = await runDelete({ category: "WORKOUT" });
    expect(result.error).toBe("not_coach_created");
    expect(result.details).toContain("intervals.icu");
    expect(deleteCalls).toEqual([]);
  });

  it("deletes a future WORKOUT with coach tag only", async () => {
    const { result, deleteCalls } = await runDelete({
      id: 55,
      category: "WORKOUT",
      tags: [COACH_EVENT_TAG],
      startDateLocal: "2999-01-01T00:00:00",
    });
    expect(result.deleted).toBe(true);
    expect(deleteCalls).toEqual([55]);
  });

  it("deletes a future WORKOUT with externalId prefix only", async () => {
    const { result, deleteCalls } = await runDelete({
      id: 56,
      category: "WORKOUT",
      externalId: `${COACH_EXTERNAL_ID_PREFIX}2999-01-01:x`,
      startDateLocal: "2999-01-01T00:00:00",
    });
    expect(result.deleted).toBe(true);
    expect(deleteCalls).toEqual([56]);
  });

  it("past-dated marked WORKOUT -> past_workout_protected (ownership passes, date refuses)", async () => {
    const { result, deleteCalls } = await runDelete({
      category: "WORKOUT",
      tags: [COACH_EVENT_TAG],
      startDateLocal: "2000-01-01T00:00:00",
    });
    expect(result.error).toBe("past_workout_protected");
    expect(deleteCalls).toEqual([]);
  });

  it("past-dated NOTE -> not_a_workout (category precedes date guard)", async () => {
    const { result, deleteCalls } = await runDelete({
      category: "NOTE",
      tags: [COACH_EVENT_TAG],
      startDateLocal: "2000-01-01T00:00:00",
    });
    expect(result.error).toBe("not_a_workout");
    expect(deleteCalls).toEqual([]);
  });
});

type ListRow = {
  id: number;
  category?: string | null;
  externalId?: string | null;
  tags?: string[] | null;
  coachCreated: boolean;
};

async function runList(events: EventKnobs[], coachCreatedOnly?: boolean) {
  const client = makeListFake(events);
  const tools = createCoreToolsWithSportConfig(client, ["Ride"]);
  return (await tools.intervals_list_events!.execute!(
    { oldest: "2026-01-01", coachCreatedOnly },
    {} as never,
  )) as ListRow[];
}

describe("intervals_list_events projection", () => {
  it("rows carry category, externalId, tags, coachCreated", async () => {
    const rows = await runList([
      { id: 1, category: "WORKOUT", tags: [COACH_EVENT_TAG], externalId: null },
    ]);
    expect(rows[0]).toMatchObject({
      id: 1,
      category: "WORKOUT",
      tags: [COACH_EVENT_TAG],
      externalId: null,
      coachCreated: true,
    });
  });

  it("coachCreated true for tag-marked, false for unmarked", async () => {
    const rows = await runList([
      { id: 1, category: "WORKOUT", tags: [COACH_EVENT_TAG] },
      { id: 2, category: "WORKOUT" },
    ]);
    expect(rows.find((r) => r.id === 1)!.coachCreated).toBe(true);
    expect(rows.find((r) => r.id === 2)!.coachCreated).toBe(false);
  });

  it("coachCreatedOnly:true filters to marked rows only", async () => {
    const rows = await runList(
      [
        { id: 1, category: "WORKOUT", tags: [COACH_EVENT_TAG] },
        { id: 2, category: "WORKOUT" },
      ],
      true,
    );
    expect(rows.map((r) => r.id)).toEqual([1]);
  });

  it("omitted coachCreatedOnly returns all rows (memoizer-arg default)", async () => {
    const rows = await runList([
      { id: 1, category: "WORKOUT", tags: [COACH_EVENT_TAG] },
      { id: 2, category: "WORKOUT" },
    ]);
    expect(rows.map((r) => r.id)).toEqual([1, 2]);
  });
});
