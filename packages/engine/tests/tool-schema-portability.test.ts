import { asSchema } from "ai";
import { describe, expect, it } from "vitest";
import {
  createCoreToolsWithSportConfig,
  createPureCoreIntervalsTools,
} from "../src/sport/platform-tools.js";
import type {
  AthleteDataReaderPort,
  PlatformCalendarMutationsPort,
} from "../src/host-ports.js";

const reader: AthleteDataReaderPort = {
  getAthlete: async () => ({ ok: true, value: {} }),
  listWellness: async () => ({ ok: true, value: [] }),
  listActivities: async () => ({ ok: true, value: [] }),
  getActivity: async () => ({ ok: true, value: {} }),
  getStreams: async () => ({ ok: true, value: {} }),
  listCalendar: async () => ({ ok: true, value: [] }),
  freshness: () => undefined,
};

const mutations: PlatformCalendarMutationsPort = {
  createEvent: async () => ({}),
  readEventForDelete: async ({ eventId }) => ({ id: eventId, startDateLocal: "2999-01-01" }),
  updateEvent: async () => ({}),
  deleteEvent: async () => ({}),
};

describe("core tool schema portability", () => {
  it("emits plain object schemas without root combinators", async () => {
    const toolsets = [
      createPureCoreIntervalsTools(null, "UTC", reader, mutations),
      createCoreToolsWithSportConfig(null, ["Ride"], reader),
    ];

    for (const toolset of toolsets) {
      for (const registered of Object.values(toolset)) {
        const current = registered as { inputSchema: never };
        const schema = (await Promise.resolve(
          asSchema(current.inputSchema).jsonSchema,
        )) as Record<string, unknown>;
        expect(schema.type).toBe("object");
        expect(schema).not.toHaveProperty("anyOf");
        expect(schema).not.toHaveProperty("oneOf");
        expect(schema).not.toHaveProperty("allOf");
      }
    }
  });
});
