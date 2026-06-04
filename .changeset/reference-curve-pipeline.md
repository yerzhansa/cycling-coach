---
"@enduragent/core": patch
---

Land the Reference layer's curve pipeline: the input schemas gain optional `power_curves`, `hr_curves`, `sustainability_curves`, `streams`, and `athlete` keys (exact upstream kwarg shapes); the snapshot harness and its native/fuzz/coverage twins destub the curve / power-model inputs in lockstep, deriving the date windows and sport thresholds ONLY when the matching fixture key is present (existing fixtures stay byte-identical). Adds `tools/build-curve-fixture.ts` and the `curve-equipped` golden fixture (sanitized real rows + synthetic curve blocks attached after the sanitizer), which populates `capability.power_curve_delta`, `capability.hr_curve_delta`, `capability.sustainability_profile`, and the six power-model scalars in the oracle snapshots. PII allowlist scan + `.sha256` checksum extended to the new fixture.

Pure dev-time + oracle infra — athletes don't notice.
