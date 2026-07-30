import type { ApiError } from "intervals-icu-api";
import { todayInTZ } from "@enduragent/engine/sport";
import { isCoachOwnedEvent } from "./event-provenance.js";

export function toTypedError(error: ApiError): {
  error: string;
  status?: number;
  message?: string;
} {
  return {
    error: error.kind,
    ...("status" in error ? { status: error.status } : {}),
    ...("message" in error ? { message: error.message } : {}),
  };
}

export type IntervalsEventRuntime = {
  id: number;
  startDateLocal: string;
  name?: string | null;
  movingTime?: number | null;
  icuTrainingLoad?: number | null;
  category?: string | null;
  tags?: string[] | null;
  externalId?: string | null;
};

export function guardDeletableEvent(
  event: IntervalsEventRuntime,
  tz: string,
  eventId: number = event.id,
): { error: string; details: string } | undefined {
  if (event.category !== "WORKOUT") {
    return {
      error: "not_a_workout",
      details: `Event ${eventId} is category ${event.category ?? "unknown"}, not a scheduled workout. Races, notes, plans, and other calendar entries cannot be deleted by the coach.`,
    };
  }
  if (!isCoachOwnedEvent(event)) {
    return {
      error: "not_coach_created",
      details:
        "This workout was not created by this coach (no provenance marker) — it may be athlete-added, from another app, or created before provenance markers shipped. It will not be deleted; the athlete can remove it directly on intervals.icu.",
    };
  }
  const today = todayInTZ(tz);
  const eventDate = event.startDateLocal.slice(0, 10);
  if (eventDate < today) {
    return {
      error: "past_workout_protected",
      details: `Cannot delete workout dated ${eventDate} — it's before today (${today}).`,
    };
  }
  return undefined;
}
