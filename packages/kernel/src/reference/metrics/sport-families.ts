/**
 * Reference layer — activity-type → sport-family lookup.
 *
 * Mirrors the `SPORT_FAMILIES` table at `sync.py:290-308`, the single
 * upstream class constant shared by the daily-Load-by-sport aggregator,
 * the seven-zone aggregator, and the Seiler aggregator. See `NOTICE.md`
 * for license attribution.
 *
 * Only the TABLE lives here. The default for an UNMAPPED type is decided
 * at each call site, because the upstream functions disagree: the
 * seven-zone `_aggregate_zones` defaults to `null` (no `prefer_hr`, rides
 * the power-preferred path), while `_get_daily_tss_by_sport` and
 * `_aggregate_seiler_zones` default to `"other"`. Callers guard with
 * `Object.hasOwn(SPORT_FAMILIES, type)` and supply their own fallback —
 * don't fold a default into this table.
 */
export const SPORT_FAMILIES: Record<string, string> = {
  Ride: "cycling",
  VirtualRide: "cycling",
  MountainBikeRide: "cycling",
  GravelRide: "cycling",
  EBikeRide: "cycling",
  VirtualSki: "ski",
  NordicSki: "ski",
  Walk: "walk",
  Hike: "walk",
  Run: "run",
  VirtualRun: "run",
  TrailRun: "run",
  Swim: "swim",
  Rowing: "rowing",
  WeightTraining: "strength",
  Yoga: "other",
  Workout: "other",
};
