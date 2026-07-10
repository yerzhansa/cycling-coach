---
"cycling-coach": patch
---

User-facing: Workouts the coach adds to your intervals.icu calendar are now marked as coach-created, and the coach will only delete its own scheduled workouts — races, notes, and workouts you added yourself are always refused.

Calendar create tools in both sport packages stamp an `external_id` and `tags` provenance marker on every event they push. The list projection surfaces `category`, `externalId`, `tags`, and a derived `coachCreated` flag, plus an opt-in `coachCreatedOnly` filter. The delete tool now refuses non-WORKOUT events (`not_a_workout`) and marker-less events (`not_coach_created`) before the destructive delete call, ahead of the existing past-date guard.
