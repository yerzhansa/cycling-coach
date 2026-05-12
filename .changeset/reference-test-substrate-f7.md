---
"@enduragent/core": patch
---

Reference test substrate + anti-corruption layer (F7 + Layer A, Wave 2).
Lands the privacy-denylist sanitizer (`tools/sanitize-fixture.ts`), the
schema-checked fixture loader (`tests/helpers/load-fixture.ts`), the
property-test arbitraries (`tests/helpers/reference-arbitraries.ts`), the
`tests/fixtures/` directory with its first golden + synthetic fixtures,
and the trademark-wall mechanical assertion
(`tests/reference-input-schemas-no-tp.test.ts`).

Repairs `ActivitySchema` in `src/reference/schemas/inputs.ts` to match
intervals.icu API reality (Decision 3 of the F7 battle plan: real shape
rides through `z.looseObject` unmodified). Surfaces revealed by piping a
real 12-week pull through the substrate:

- `Activity.id` accepts `string | number` (the API uses both forms).
- `Activity.average_watts`, `average_heartrate`, `icu_training_load`,
  `icu_intensity` are now `.optional()` — real activities can lack a power
  meter (no Ride power data), an HR strap, or a load score (WeightTraining).
- `icu_zone_times` / `pace_zone_times` / `hr_zone_times` accept the union
  `Array<number | { id?, secs }>` via the new shared `ZoneTimeEntrySchema`,
  and are `.nullable()` because the API writes `null` (not just absent)
  for activities lacking the series.

Adds the anti-corruption layer (ADR-0012) between intervals.icu's
TP-trademarked API fields and the project's typed surface:

- `src/reference/trademark-policy.ts` — single source of truth for
  `TP_API_FIELDS` (7) and `TP_DENYLIST_FIELDS` (10). Migrates the
  sanitize helper and the no-TP regression test to import from it.
- `src/reference/sync/rename-tp-fields.ts` — `renameTpFieldsOnWellnessRow`,
  `renameTpFieldsOnActivity`, and a defensive `assertNoTpKeysRemain`
  recursive walker (uses `[<index>]` paths only — no row-id leakage).
- `schemas/inputs.ts` — 5 new wellness fields (`fitness`, `fatigue`,
  `fitnessContribution`, `fatigueContribution`, `weeklyFitnessChange`)
  and 2 new activity fields (`fitnessAtEnd`, `fatigueAtEnd`).
- `tools/sanitize-fixture.ts` — pipeline now reads raw bundle → rename →
  `assertNoTpKeysRemain` → sanitize → atomic write. Non-number TP values
  surface as a stderr aggregate-warn so operator drift fails loudly.
- `tools/fetch-real-athlete.ts` — operator fetch CLI promoted from the
  gitignored `scripts/` directory; the two tools now form one operator
  pipeline.
- Regenerated `tests/fixtures/golden/realistic-athlete.json` with plain-
  English keys throughout; F8-F11 metric tests consume `fitness` /
  `fatigue` / `fitnessAtEnd` directly without reaching into the
  index-signature underlay.

Pure-infra; no athlete-visible changes.
