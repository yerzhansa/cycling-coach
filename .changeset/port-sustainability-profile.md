---
"@enduragent/core": patch
---

Port the Reference layer's `capability.sustainability_profile` metric — the per-sport race-estimation lookup table. For each active sport family carried in the `sustainability_curves` input, it extracts observed mean-maximal power and max sustained HR at sport-specific anchor durations from a single 42-day window, and (cycling only) layers two predicted-power models: Coggan duration factors (FTP × factor) and the CP/W' model (P = CP + W'/t, CP approximated by athlete-set FTP). The single 42d window is gated on the harness having fetched the curve bundle, so the 12 curve-free fixtures reproduce the bare null block byte-for-byte; the curve-equipped fixture populates the full cycling block (observed watts/HR, W/kg, %LTHR, Coggan + CP/W' predicted watts, model divergence) bit-identically against the oracle snapshot. Transliterates the upstream's `_build_sport_thresholds` (athlete `sportSettings` array → per-family threshold map) and `_is_indoor_cycling` helpers; reads `power_model.w_prime` from the same live power-model extraction the scalar passthroughs use, and walks the weight fallback chain (wellness_7d → wellness_extended → athlete weight).

Pure Reference-layer + oracle parity work — athletes don't notice yet.
