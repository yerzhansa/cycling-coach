---
"@enduragent/core": patch
---

Port the Reference layer's `capability.dfa_a1_profile` metric — DFA-alpha1 LT1/LT2 threshold estimation from per-second AlphaHRV streams. The full pipeline is transliterated line-by-line: the streams-assembly path joins each fixture `streams` record (keyed by `String(activity.id)`) back to the activities array, runs each record carrying a `dfa_a1` channel through the per-session DFA block builder (sentinel-zero + artifact filtering, validity gate, percentile/TIZ-band rollups, first-vs-last-third drift, LT1/LT2 crossing-band HR/watts estimates), and feeds the qualifying sessions into the profile aggregator (latest sufficient session + per-sport-family trailing window with confidence tiers and indoor/outdoor watts split for cycling). The 12 stream-free fixtures reproduce the null profile byte-for-byte; the stream-equipped fixture populates the full cycling block bit-identically against the oracle snapshot (confidence high, lt1 {hr 141, watts_outdoor 181}, lt2 {hr 169, watts_outdoor 261}). Numerically faithful: every `round()` site uses banker's rounding on the exact double (including Python's no-arg `round(x)` integer form), and float `sum()` sites use compensated summation to match CPython 3.12+.

Pure Reference-layer + oracle parity work — athletes don't notice yet.
