---
"@enduragent/core": patch
---

Land the Reference layer's dfa stream fixture: the snapshot harness and its native/fuzz/coverage twins gain the dfa-assembly path in lockstep — when a fixture carries the optional `streams` key, each per-second stream record (keyed by `String(activity.id)`) is joined back to the activities array and run through the upstream's own `_compute_dfa_block` to prime `_intervals_data`, deriving the dfa entries ONLY when `streams` is present (the 12 existing fixtures carry none, so their snapshots stay byte-identical). Adds `tools/build-dfa-fixture.ts` and the fully-synthetic `dfa-equipped` golden fixture (7 Ride sessions with generated per-second dfa_a1/artifacts/heartrate/watts streams, no sanitizer, no real data), which populates `capability.dfa_a1_profile` in the oracle snapshots at confidence=high with non-null lt1/lt2 estimates. The builder ends with a non-vacuity guard recomputing the sufficiency + crossing-band thresholds; PII allowlist scan + `.sha256` checksum extended to the new fixture.

Pure dev-time + oracle infra — athletes don't notice.
