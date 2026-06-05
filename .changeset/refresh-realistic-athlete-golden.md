---
"@enduragent/core": patch
---

Refresh the realistic-athlete golden test fixture so it carries the current
sanitizer pass-through field surface. The committed golden predated the
`icu_variability_index` and per-activity heart-rate-recovery pass-through fields
the sanitizer now emits (0 occurrences in the stale golden vs 38 each after a
fresh regen), which kept the fixture-stability test red. Regenerating the golden
from the same source dump through the current sanitizer restores those fields;
the calendar-shift, account-id, and trademark-rename invariants all still hold,
and the refresh was re-verified bit-identical through both snapshot runtimes
(WASM + native twin) and the full parity gate. With the variability-index field
now present, the variability-filtered capability sub-metrics qualify sessions as
expected — efficiency-factor and durability snapshots move to their correct
non-empty values — and every other fixture's snapshots stay byte-identical. No
Reference-layer metric code changed.

Internal test-fixture refresh; no runtime behavior change.
