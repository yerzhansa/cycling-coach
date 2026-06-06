---
"@enduragent/core": patch
---

Reference test substrate — privacy hardening + review-feedback polish

- Inverted the fixture sanitizer from denylist to allowlist (`tests/helpers/sanitize-fixture.ts`). Default-deny: every key outside the schema-derived allowlist is dropped. The prior denylist missed several operator-identifying fields (`power_meter_serial`, `power_meter`, `source` on activity rows, `skyline_chart_bytes`, `athlete_max_hr`, `lthr`, hardware vendor names) — now removed structurally. `realistic-athlete.json` regenerated and shrunk from 347KB to 70KB.
- Replaced the PII regression scanner with a single allowlist assertion that walks the committed fixture and asserts every key appears in `ALLOWED_FIXTURE_KEYS`. Adds a defense-in-depth check that every `*_id` value is the redacted sentinel.
- Hardened the rename layer (`reference/sync/rename-tp-fields.ts`) to throw on collisions where the input has both a TP source key and a non-null rename target. Null targets ride through (the real `atl`/`fatigue: null` pattern intervals.icu ships).
- CLI (`tools/sanitize-fixture.ts`) now rejects unrecognized `--<flag>` arguments with a non-zero exit + stderr listing known flags. Prior CLI silently swallowed typos like `--force-overrride`.
- Property-test arbitraries: `icu_efficiency_factor` is null when `average_heartrate` is null (same physical constraint as `decoupling`/`pa_hr`). `icu_training_load` and `icu_intensity` wrapped in `fc.option` to exercise the `undefined` branch (WeightTraining shape).

Pure-infra changeset — athletes don't notice; the change tightens the privacy boundary on a test fixture.
