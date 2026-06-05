---
"@enduragent/core": patch
---

Mirror the snapshot harness's event/benchmark kwarg surface into the fuzz-parity
oracle twin. The twin hardcoded `past_events=[]` and `benchmark_indoor` /
`benchmark_outdoor` to the `(None, None, None)` insufficient-history stub, which
is false for the populated-benchmark-and-consistency fixture: that fixture
carries indoor/outdoor FTP history, so the twin's stub fed the null branch while
the real TS path computed the populated branch, producing a guaranteed false
MISMATCH on `benchmark_indoor`, `benchmark_outdoor`, `consistency_index`, and
`consistency_details`. The twin now reads the five optional fixture keys
(`past_events`, `current_ftp_indoor`/`outdoor`, `ftp_history_indoor`/`outdoor`)
through the contract tracker — all allowlisted in `optionalFixturePaths` — and
hands the FTP data to the upstream's own `_calculate_benchmark_index`, matching
the snapshot harness line-for-line. Absent keys reproduce the prior stub so the
fixtures carrying none stay byte-identical; the populated branch now actually
runs. The three harness twins stay independent reimplementations of the same
logic shape.

Pure dev-time oracle infra — athletes don't notice.
