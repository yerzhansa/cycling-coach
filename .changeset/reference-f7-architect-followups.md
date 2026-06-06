---
"@enduragent/core": patch
---

Reference substrate — architect-review follow-ups on top of the test-substrate landing.

- **Tightened the `metrics/` re-export gate.** Added a second describe block to `tests/reference-strict-schemas.test.ts` that scans `metrics/*.ts` for `export const *Schema` declarations and asserts each appears in the `metrics/index.ts` barrel. Previously the README's Rule 1 ("every metric schema must be re-exported") was reviewer-enforced — the existing `length > 0` check still passed because the cache barrel supplied the count, so a missed future re-export would slip through. Skipped today because no metric schemas declared yet; activates when the first metric schema lands.
- **Branded the rename layer's return types** so the anti-corruption boundary (ADR-0012) is enforced at the type level. `renameTpFieldsOnActivity` / `renameTpFieldsOnWellnessRow` now return `RenamedActivityRow` / `RenamedWellnessRow` (phantom-branded with a `unique symbol`). Two new helpers `parseRenamedActivity(row)` and `parseRenamedWellnessRow(row)` accept only branded input — a sync-path author who calls `ActivitySchema.parse(apiResponse)` directly bypasses the rename layer; the parse helpers turn that bypass into a type error. Defense-in-depth only — the schemas remain publicly exported, so the brand catches forgetfulness, not malice. Pair with `assertNoTpKeysRemain` for nested-aggregate drift.
- **Stripped the section-11 attribution comment from `metrics/index.ts`.** The barrel is a project-original contract scaffold (it adapts no upstream code); per the just-merged commit `dc5bca4` discipline, attribution belongs only on files that genuinely originate from section-11.
- **Documentation.** `metrics/README.md` Rule 1 now points at the mechanical gate; Rule 3 gains the rule-of-three corollary ("and when the third metric does need it, extract it"). `reference/CONTEXT.md`'s metric-wiring obligation now tells future authors to go through `parseRenamedActivity` / `parseRenamedWellnessRow` instead of calling the schemas directly.

Pure-infra changeset — athletes don't notice; this tightens drift gates that protect future metric authors.
