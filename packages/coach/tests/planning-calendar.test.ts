import type { IntervalsClient } from "intervals-icu-api";
import { describe, expect, it, vi } from "vitest";
import { createPlanMirrorCalendarAdapter } from "../src/planning-calendar.js";

describe("Plan Intervals calendar adapter", () => {
  it("uses provider UIDs as durable Plan workout identities", async () => {
    const list = vi.fn(async () => ({
      ok: true as const,
      value: [
        {
          id: 42,
          startDateLocal: "2026-08-25T00:00:00",
          category: "WORKOUT",
          uid: "cycling-coach:plan:plan:workout",
        },
      ],
    }));
    const create = vi.fn(async (body: unknown) => ({
      ok: true as const,
      value: { id: 43, ...(body as object) },
    }));
    const remove = vi.fn(async () => ({ ok: true as const, value: {} }));
    const client = {
      events: { list, create, delete: remove },
    } as unknown as IntervalsClient;
    const calendar = createPlanMirrorCalendarAdapter(() => client);

    await expect(
      calendar.listEvents({ startDateKey: 20260825, endDateKey: 20260831 }),
    ).resolves.toEqual([
      {
        id: 42,
        dateKey: 20260825,
        externalId: "cycling-coach:plan:plan:workout",
        category: "WORKOUT",
      },
    ]);
    await calendar.createEvent({
      planId: "00000000000000000000000001",
      planWorkoutId: "00000000000000000000000002",
      dateKey: 20260826,
      externalId: "cycling-coach:plan:plan:workout-2",
      name: "Threshold 4×8",
      sport: "cycling",
      durationS: 4_800,
      structureJson: JSON.stringify({ description: "Four threshold efforts." }),
    });
    await calendar.deleteEvent({ eventId: 42 });

    expect(list).toHaveBeenCalledWith({
      oldest: "2026-08-25",
      newest: "2026-08-31",
      category: ["WORKOUT"],
    });
    expect(create).toHaveBeenCalledWith(
      {
        startDateLocal: "2026-08-26T00:00:00",
        category: "WORKOUT",
        name: "Threshold 4×8",
        type: "Ride",
        uid: "cycling-coach:plan:plan:workout-2",
        movingTime: 4_800,
        description: "Four threshold efforts.",
      },
      { upsertOnUid: true },
    );
    expect(remove).toHaveBeenCalledWith(42);
  });

  it("fails closed when Intervals credentials are absent", async () => {
    const calendar = createPlanMirrorCalendarAdapter(() => null);
    await expect(
      calendar.listEvents({ startDateKey: 20260825, endDateKey: 20260831 }),
    ).rejects.toThrow("Intervals credentials are required");
  });
});
