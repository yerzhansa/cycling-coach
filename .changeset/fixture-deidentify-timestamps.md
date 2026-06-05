---
"@enduragent/core": patch
---

De-identify the three real-data Reference test fixtures (realistic-athlete,
capability-qualifying, curve-equipped): every embedded calendar date is shifted
back one full Gregorian cycle (28 years) to a synthetic epoch, and the few real
account identifiers used as test literals are replaced with synthetic
placeholders. The 28-year shift preserves weekday, month-day, time-of-day, and
all relative spacing, so every windowed metric value is bit-identical — only
date labels change (verified: zero non-date value diffs vs the prior snapshots,
all parity gates green). Adds `pnpm check:fixture-privacy`, a shape-based CI lint
that blocks real-shaped account ids and current-era dates from re-entering
committed fixtures, and shifts the sanitizer/builders so future regenerations
de-identify automatically.

Internal test-fixture + dev-tooling change; no runtime behavior change.
