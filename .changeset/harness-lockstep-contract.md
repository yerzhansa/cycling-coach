---
"@enduragent/core": patch
---

Extract the snapshot harness's four-way lockstep surface into one
language-neutral contract file (`tools/harness-contract.json`). The
optional-path allowlist (previously duplicated across the pyodide harness,
the fuzz-parity differential, and the README — three copies that had already
diverged), the fixture-key → derived-kwarg conditions, and the power/HR
delta-window day-offsets now live in a single source of truth that the two
TypeScript files read through `tools/harness-contract.ts` and the two Python
twins `json.load` relative to their own path. Each file keeps its own logic —
only the literal data moves — so the twins stay independent reimplementations
and the cross-interpreter diff remains a real check. The README's allowlist
block is now test-asserted against the contract rather than hand-synced, and
`packages/core/tests/harness-contract.test.ts` adds source-level drift
tripwires that fail if any harness file re-grows an inline copy of the
extracted literals. Pure refactor: snapshot regeneration is byte-identical,
the native diff is 0 divergences on the realistic / curve / dfa fixtures, and
the fuzz-parity failure set is unchanged.

Pure dev-time + oracle infra — athletes don't notice.
