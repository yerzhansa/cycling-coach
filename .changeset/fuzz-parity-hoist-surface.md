---
"@enduragent/core": patch
---

Mirror the snapshot harness's hoist surface into the fuzz-parity oracle twin so
its differential covers the metrics whose values flow through the hoist blocks
rather than the flat `_calculate_derived_metrics` dump. The fuzz oracle now
carries the full hoist surface the pyodide snapshot harness and native CPython
twin already emit: three value-emitting hoists — the per-activity
`has_intervals` and `effort_response_signal` classifier maps and the
`weight_signal` block — plus the explosion of the nested `capability` dict into
`capability.<sub>` sibling keys. Without them the fuzz oracle emitted nothing
for those keys and the `?? null` mask silently compared the real TS value
against null, so the hoisted metrics (`has_intervals`, `effort_response_signal`,
`weight_signal`, and the `capability.*` sub-key metrics) reported a spurious
mismatch on every run. The hoist blocks reparse the raw fixture JSON to bypass
the contract tracker (matching the snapshot harness) and run on the success path
before the final serialize, with the capability explosion after the
contract-violation guard so a violation still short-circuits. The three harness
twins stay independent reimplementations of the same logic shape.

Pure dev-time oracle infra — athletes don't notice.
