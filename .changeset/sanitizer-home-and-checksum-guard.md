---
"@enduragent/core": patch
---

Reference test substrate — sanitizer home + fixture checksum (follow-up to #100)

- Moved the fixture sanitizer from `packages/core/tests/helpers/sanitize-fixture.ts` to `tools/sanitize-fixture-transform.ts`. The sanitizer is operator tooling (one CLI consumer, run on the operator's laptop) — `tools/` is the right home alongside `check-trademarks.ts` and `fetch-real-athlete.ts`. Tests now import the transform via `tools/sanitize-fixture-transform.js` (dependency direction matches lifecycle: tests verify operator-produced artifacts).
- Added `realistic-athlete.json.sha256` next to the committed fixture. CI verifies the two match on every run via `realistic-athlete-fixture-checksum.test.ts` — catches accidental in-place mutation (bad merge, editor save, formatter pass) that the operator-only byte-stability test doesn't see. The sanitize CLI now emits the checksum alongside the JSON, so operator regens stay in sync.
- CONTRIBUTING.md gained a "Fixture stewardship" subsection naming the regen flow, the checksum guard, and the reviewer obligation when schema additions widen the allowlist.

Pure-infra changeset.
