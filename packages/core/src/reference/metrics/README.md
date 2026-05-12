# Reference metrics — re-export discipline

This directory holds Wave 2's metric computers (F8–F11). The strict-schemas
regression test at `packages/core/tests/reference-strict-schemas.test.ts`
walks `index.ts` to assert every Zod object schema declares `.strict()`.
When a metric schema is exported from a sibling file (e.g.,
`load-management.ts`) but NOT re-exported through `index.ts`, the
strict-test won't catch it — the schema bypasses the drift gate silently.

**Rule 1 — re-export discipline**: every Zod schema declared inside
`metrics/*.ts` MUST be re-exported from `metrics/index.ts`. Add the
re-export in the same PR that adds the schema. Mechanically enforced by
the second `describe` in `tests/reference-strict-schemas.test.ts`, which
scans `metrics/*.ts` for `export const *Schema` declarations and asserts
each appears in the barrel.

**Rule 2 — optional-chaining discipline**: when a metric reads an
`.optional()` field on `Activity`/`WellnessDay`/etc. (e.g.,
`activity.icu_intervals`, `wellness.bodyFat`), use optional-chaining or
explicit `=== undefined` checks — never the `in` operator.

The `in` operator distinguishes "key present with `undefined` value" from
"key absent." F7's property-test arbitraries use
`fc.option(..., { nil: undefined })` which produces
present-key-with-`undefined` (Zod accepts it; type-checks; serializes); but
`'key' in obj` returns `true` for that shape. Metric authors who use
`'key' in obj` will not exercise the missing-data branch under property
tests, and F11's `has_intervals` regression case in particular needs the
optional-chaining form (`activity.icu_intervals?.some(...)`) to detect the
section-11 v3.106 bug class.

**Rule 3 — zone-times shape variance is read-side, not ingest-side**:
`Activity.icu_zone_times` / `pace_zone_times` / `hr_zone_times` are typed
as `Array<number | { id?: string; secs: number }>` because intervals.icu
returns the object form for native bins and the bare-number form for
pre-flattened payloads (Decision 3 of the F7 battle plan: real intervals.icu
shape rides through the schema unmodified). Metric computers normalize at
read time:

```ts
const flat = (activity.icu_zone_times ?? []).map(
  (x) => (typeof x === "number" ? x : x.secs),
);
```

Inline this in F9's first call site. **Don't extract a `normalizeActivity()`
or `flattenZoneTimes()` helper preemptively** — by the rule of three, wait
until the third metric needs it; until then, inlining is cheaper than a
shared abstraction that freezes the wrong shape. ADR-0009 ("defer library
publishing until a real second consumer exists") is the project's published
stance against this kind of speculative extraction; it applies one layer
down too. **And when the third metric does need it, extract it** —
otherwise F11 review opens with four identical copy-pastes.

Rule 1 is mechanically gated (see above). Rules 2 and 3 are enforced by
reviewer attention. A future PR may add an ESLint rule banning
`'<input-field>' in <obj>` for known-optional fields.
