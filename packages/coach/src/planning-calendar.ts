import type { EventInput, IntervalsClient } from "intervals-icu-api";
import type { PlanMirrorCalendarPort, PlanMirrorCreateInput } from "@enduragent/engine";

function clientValue<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error("Intervals calendar request failed.", { cause: result.error });
  return result.value;
}

function dateText(dateKey: number): string {
  const value = String(dateKey).padStart(8, "0");
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

function dateKey(value: string): number {
  const parsed = Number(value.slice(0, 10).replaceAll("-", ""));
  if (!Number.isSafeInteger(parsed)) throw new TypeError("Intervals returned an invalid date.");
  return parsed;
}

function eventType(sport: string): NonNullable<EventInput["type"]> {
  const normalized = sport.toLowerCase();
  if (normalized.includes("cycl") || normalized.includes("bike")) return "Ride";
  if (normalized.includes("run")) return "Run";
  if (normalized.includes("swim")) return "Swim";
  return "Workout";
}

function eventContent(
  input: PlanMirrorCreateInput,
): Pick<EventInput, "description" | "workoutDoc"> {
  try {
    const value = JSON.parse(input.structureJson) as Record<string, unknown>;
    return {
      ...(typeof value.description === "string" ? { description: value.description } : {}),
      ...(typeof value.workoutDoc === "object" && value.workoutDoc !== null
        ? { workoutDoc: value.workoutDoc as NonNullable<EventInput["workoutDoc"]> }
        : {}),
    };
  } catch {
    return {};
  }
}

export function createPlanMirrorCalendarAdapter(
  readClient: () => IntervalsClient | null,
): PlanMirrorCalendarPort {
  const requiredClient = (): IntervalsClient => {
    const client = readClient();
    if (client === null) throw new Error("Intervals credentials are required.");
    return client;
  };
  const adapter: PlanMirrorCalendarPort = {
    async listEvents(input) {
      const events = clientValue(
        await requiredClient().events.list({
          oldest: dateText(input.startDateKey),
          newest: dateText(input.endDateKey),
          category: ["WORKOUT"],
        }),
      );
      return events.map((event) => ({
        id: event.id,
        dateKey: dateKey(event.startDateLocal),
        externalId: event.uid ?? null,
      }));
    },
    async createEvent(input) {
      return clientValue(
        await requiredClient().events.create(
          {
            startDateLocal: `${dateText(input.dateKey)}T00:00:00`,
            category: "WORKOUT",
            name: input.name,
            type: eventType(input.sport),
            uid: input.externalId,
            ...(input.durationS === null ? {} : { movingTime: input.durationS }),
            ...eventContent(input),
          },
          { upsertOnUid: true },
        ),
      );
    },
    async deleteEvent(input) {
      return clientValue(await requiredClient().events.delete(input.eventId));
    },
  };
  return Object.freeze(adapter);
}
