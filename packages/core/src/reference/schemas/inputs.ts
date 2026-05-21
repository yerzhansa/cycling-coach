//
// Why z.looseObject and not .strict(): cache schemas gate against on-disk
// drift via .strict(). Input schemas project upstream-API responses we
// don't control — strict here would mean every new field intervals.icu
// adds anywhere blows up Reference.
//
// Trademark hygiene: TP-named fields (`ctl`, `atl`, `tsb`, `tss`, `if`,
// `icu_atl`, `icu_ctl`, `ctlLoad`, `atlLoad`, `rampRate`) are deliberately
// excluded from the named field set. Real payloads still round-trip via
// the index-signature; the denylist test
// (`tests/reference-input-schemas-no-tp.test.ts`) blocks reintroduction.
// See `docs/knowledge/research/trademark-tp-terms.md`.

import { z } from "zod";

/** Per-rep workout segment from intervals.icu's `icu_intervals` array. */
export const IcuIntervalRepSchema = z.looseObject({
  type: z.string(), // "WORK", "RECOVERY", "WARMUP", etc.
  duration: z.number().nonnegative(), // seconds
  average_watts: z.number().nullable().optional(),
  average_heartrate: z.number().nullable().optional(),
});
export type IcuIntervalRep = z.infer<typeof IcuIntervalRepSchema>;

/** Per-bin zone-time entry as returned by intervals.icu. The API returns
 *  the object form `{id: "Z1", secs: N}` for native bins and the bare
 *  `number` form for pre-flattened payloads. The lib's own ActivitySchema
 *  encodes the same union; we mirror it here so `z.looseObject()` keeps
 *  its promise — real intervals.icu shape rides through unmodified. */
export const ZoneTimeEntrySchema = z.union([
  z.number().nonnegative(),
  z.looseObject({
    id: z.string().optional(),
    secs: z.number().nonnegative(),
  }),
]);
export type ZoneTimeEntry = z.infer<typeof ZoneTimeEntrySchema>;

/** Time-in-zone breakdown — Seiler 3-zone bins are derived from these. */
export const ZoneTimesSchema = z.looseObject({
  z1: z.number().nonnegative().optional(),
  z2: z.number().nonnegative().optional(),
  z3: z.number().nonnegative().optional(),
  z4: z.number().nonnegative().optional(),
  z5: z.number().nonnegative().optional(),
  z6: z.number().nonnegative().optional(),
  z7: z.number().nonnegative().optional(),
});
export type ZoneTimes = z.infer<typeof ZoneTimesSchema>;

/** Single intervals.icu activity, projected to fields metric layers consume. */
export const ActivitySchema = z.looseObject({
  // Identity + timing — the API returns activity ids in either string form
  // ("i146622609") or number form (17654321) depending on the endpoint and
  // sport; we mirror that union so real intervals.icu shape rides through.
  id: z.union([z.string(), z.number()]),
  start_date_local: z.string(), // ISO 8601
  type: z.string(), // "Ride", "VirtualRide", "Run", etc.
  moving_time: z.number().nonnegative(),
  elapsed_time: z.number().nonnegative(),

  // Load + intensity. Optional because intervals.icu may omit them on
  // sessions it can't load-score (e.g., WeightTraining); the lib's own
  // ActivitySchema marks them nullish for the same reason.
  icu_training_load: z.number().nonnegative().optional(),
  icu_intensity: z.number().nonnegative().optional(),

  // Power + HR. Optional because real activities can lack a
  // power meter (no Ride power data) or a HR strap (forgotten / dead).
  average_watts: z.number().nullable().optional(),
  average_heartrate: z.number().nullable().optional(),

  // Zone-time breakdowns. See ZoneTimeEntrySchema above for the
  // number-vs-object union the API actually returns. Nullable because
  // intervals.icu writes `null` (not just absent) for activities that
  // lack the zone-time series — e.g., a strength session has no
  // pace_zone_times and the API ships the field with a null value.
  icu_zone_times: z.array(ZoneTimeEntrySchema).nullable().optional(),
  pace_zone_times: z.array(ZoneTimeEntrySchema).nullable().optional(),
  hr_zone_times: z.array(ZoneTimeEntrySchema).nullable().optional(),

  // Capability proxies
  decoupling: z.number().nullable().optional(),
  pa_hr: z.number().nullable().optional(),
  icu_efficiency_factor: z.number().nullable().optional(),
  icu_intervals: z.array(IcuIntervalRepSchema).optional(),

  // Compliance
  paired_event_id: z.number().nullable().optional(),
  rpe: z.number().nullable().optional(),

  // Energy / output
  kj: z.number().nonnegative().optional(),

  // Normalized fitness/fatigue snapshots at activity end — emitted by the
  // anti-corruption layer at `reference/sync/rename-tp-fields.ts` per
  // ADR-0012 from the TP-trademarked source fields the API exposes.
  fitnessAtEnd: z.number().nullable().optional(),
  fatigueAtEnd: z.number().nullable().optional(),
});
export type Activity = z.infer<typeof ActivitySchema>;

/** Single intervals.icu wellness row.
 *  Excludes ctl/atl/ctlLoad/atlLoad/rampRate/icu_atl/icu_ctl from typed surface
 *  per project trademark policy (docs/knowledge/research/trademark-tp-terms.md).
 *  Runtime shape includes them via z.looseObject(); sanitize cosmetic-drops in JSON. */
export const WellnessDaySchema = z.looseObject({
  id: z.string(), // ISO date YYYY-MM-DD
  weight: z.number().nullable(), // kg
  restingHR: z.number().nullable(),
  hrv: z.number().nullable(),
  sleepSecs: z.number().nullable(),
  sleepQuality: z.number().nullable(),

  // Body composition
  bodyFat: z.number().nullable().optional(),
  leanMass: z.number().nullable().optional(),

  // Subjective
  soreness: z.number().nullable().optional(),

  // VO2max
  vo2max: z.number().nullable().optional(),

  // Normalized fitness/fatigue fields — emitted by the anti-corruption layer
  // at `reference/sync/rename-tp-fields.ts` per ADR-0012. The source API
  // names are TP-trademarked and never appear on the typed surface; the
  // rename layer is the single anti-corruption boundary. Naming note:
  // intervals.icu's lib also declares a `fatigue` field (subjective 1-5
  // scale) on WellnessRecord — distinct semantics from this Banister-derived
  // emission. The lib's field stays index-signature ride-through; future
  // consumers needing the subjective scale should promote it under a
  // different name (e.g., `subjectiveFatigue`).
  fitness: z.number().nullable().optional(),
  fatigue: z.number().nullable().optional(),
  fitnessContribution: z.number().nullable().optional(),
  fatigueContribution: z.number().nullable().optional(),
  weeklyFitnessChange: z.number().nullable().optional(),
});
export type WellnessDay = z.infer<typeof WellnessDaySchema>;

/** Weekly load aggregate — input shape for weekly metrics. */
export const WeeklyRollupSchema = z.looseObject({
  weekStartDate: z.string(), // ISO date YYYY-MM-DD (Monday)
  weeklyLoad: z.number().nonnegative(),
  dailyLoads: z.array(z.number().nonnegative()).length(7),
  weeklyRecoveryHours: z.number().nonnegative(),
});
export type WeeklyRollup = z.infer<typeof WeeklyRollupSchema>;

/** Single FTP history point. */
export const FtpHistoryPointSchema = z.looseObject({
  date: z.string(),
  ftp: z.number().int().positive(),
  source: z.enum(["test", "estimate"]),
});
export type FtpHistoryPoint = z.infer<typeof FtpHistoryPointSchema>;

/** Calendar event — planned workout for compliance/consistency metrics. */
export const PlannedEventSchema = z.looseObject({
  id: z.number(),
  category: z.string(), // "WORKOUT", "RACE", etc.
  start_date_local: z.string(),
  name: z.string().optional(),
});
export type PlannedEvent = z.infer<typeof PlannedEventSchema>;
