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

/** Per-bin zone-time entry. The pace/HR zone-time fields can appear either as
 *  the object form `{id: "Z1", secs: N}` or a bare-number form (pre-flattened
 *  seconds); this union stays permissive for those because their shape isn't
 *  pinned to the oracle. `icu_zone_times` is the exception — it is object-form
 *  ONLY (see `IcuZoneTimeEntrySchema`). */
export const ZoneTimeEntrySchema = z.union([
  z.number().nonnegative(),
  z.looseObject({
    id: z.string().optional(),
    secs: z.number().nonnegative(),
  }),
]);
export type ZoneTimeEntry = z.infer<typeof ZoneTimeEntrySchema>;

/** `icu_zone_times` entry — object form `{id, secs}` only, never a bare number.
 *  The upstream protocol reads this field with `zone.get("id")` /
 *  `zone.get("secs")` and raises `AttributeError` on a bare number (an `int`
 *  has no `.get`). So a bare-number entry is a shape the oracle cannot process
 *  and the parity gate can never capture; accepting it here would only let it
 *  reach the read side, which doesn't recognize it and silently undercounts the
 *  activity's zone time. Reject it at the boundary — object-form is the API's
 *  native bin shape (confirmed against the upstream's `_get_activity_zones`)
 *  and the only portable one. `secs` is optional: the oracle reads it as
 *  `zone.get("secs", 0)` and the reader coerces a missing value to 0, so a
 *  `{ id }`-only bin is processable (contributes 0), not a parse failure. */
export const IcuZoneTimeEntrySchema = z.looseObject({
  id: z.string().optional(),
  secs: z.number().nonnegative().optional(),
});
export type IcuZoneTimeEntry = z.infer<typeof IcuZoneTimeEntrySchema>;

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

  // Zone-time breakdowns. `icu_zone_times` is object-form only
  // (IcuZoneTimeEntrySchema) — the shape the upstream reads and the only one
  // the parity gate can capture; the pace/HR fields stay on the permissive
  // union since their shape isn't pinned. Nullable because intervals.icu
  // writes `null` (not just absent) for activities that lack the zone-time
  // series — e.g., a strength session has no pace_zone_times and the API
  // ships the field with a null value.
  icu_zone_times: z.array(IcuZoneTimeEntrySchema).nullable().optional(),
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

/**
 * Top-level envelope for a golden fixture. The shape every parity-gate
 * metric receives. Strict at the envelope level (rogue top-level keys
 * fail the parse — typos can't masquerade as silently-present optional
 * fields); per-row schemas remain `z.looseObject()` so real upstream
 * shape rides through (see the file header on the trademark-hygiene
 * justification for that decision).
 *
 * Adding a new field is an explicit schema change: a new fixture key
 * that isn't here fails parse at the gate boundary, forcing the
 * accessor + schema to land in lockstep. That friction is the point —
 * it's what stops a sixth-or-seventh ad-hoc `as { ... }` cast from
 * accreting in metric files when an author judges the schema-update
 * tax to be higher than an inline cast (the pattern that proliferated
 * before this seam landed).
 *
 * Used by:
 *   - `tools/check-metric-parity.ts` — parses every fixture at the
 *     gate boundary; metric implementations see a typed shape, never
 *     `unknown`.
 *   - `packages/core/tests/helpers/load-fixture.ts` — the test loader
 *     re-uses this schema as its validation surface (no duplicate
 *     definition).
 */
export const FixtureSchema = z
  .object({
    activities: z.array(ActivitySchema),
    wellness: z.array(WellnessDaySchema),
    ftp_history: z.array(FtpHistoryPointSchema),

    // Optional fixture extensions for the compliance + benchmark batch.
    // None of the current committed fixtures populate these; the schema
    // declares them so future populated-branch fixtures can land
    // without a rogue-key parse failure.
    past_events: z.array(PlannedEventSchema).optional(),
    current_ftp_indoor: z.number().nullable().optional(),
    current_ftp_outdoor: z.number().nullable().optional(),
    ftp_history_indoor: z.record(z.string(), z.number()).optional(),
    ftp_history_outdoor: z.record(z.string(), z.number()).optional(),

    // Per-activity intervals lookup, mirroring upstream's intervals.json
    // surface (a distinct API endpoint from activities). Keyed by activity
    // id as a string. Optional so existing fixtures without the key still
    // validate. Only the `intervals[].type` field is consumed by the
    // current Reference port (`has_intervals` WORK-segment classifier);
    // other fields ride through via the loose row schemas. See ADR-0017.
    intervals: z
      .record(
        z.string(),
        z.looseObject({
          intervals: z
            .array(z.looseObject({ type: z.string() }))
            .optional(),
        }),
      )
      .optional(),
  })
  .strict();
export type FixtureShape = z.infer<typeof FixtureSchema>;
