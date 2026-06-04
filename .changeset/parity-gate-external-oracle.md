---
"@enduragent/core": patch
---

Extend the Reference layer's parity gate (`pnpm check-parity`) with an
`--oracle=section-11|external|both` mode (default `section-11`,
byte-for-byte unchanged). The external mode cross-checks the
`curve-equipped` fixture's integer-floored mean-max curve anchors (power
win1/win2, HR win1/win2, sustainability power + HR) against an independent
external oracle that recomputes the same mean-max quantities from the same
underlying rides — grounding the fixture curves the ported capability
metrics consume in a second computation. The oracle emits floats and the
fixture floors them (intervals.icu convention), so the gate enforces the
documented `fixture == floor(oracle)` relation; the per-quantity tolerance
and coverage live ONLY in `tools/intentional-deviations.yaml`'s new
`external_coverage` section (the gate refuses any tolerance kind not
declared there, and never accepts an inline or CLI-tunable epsilon).
`--oracle=both` runs the section-11 bit-identity matrix and the external
cross-check and fails if either leg fails (a declared external quantity
with no snapshot is a both-mode failure, not a skip); a run that finds zero
covered quantities exits non-zero rather than passing empty. The seven
immutable external-oracle snapshot wrappers ship under
`external-oracle-snapshots/curve-equipped/`; the per-ride CP-model file is
retained but recorded as uncovered (the athlete-level eFTP/W'/PMax in our
fixtures are config inputs, so the cross-check anchors on the mean-max
curves).

Pure dev-time + oracle tooling — athletes don't notice.
