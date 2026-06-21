---
"@enduragent/core": patch
---

Make the `derived_metrics_meta` provenance honest. Rename `basis` to `prescriptionBasis` (the adapter's declared prescription anchor — `power`/`pace`) and add a separate `analysisBasis` carrying the substrate the distribution numbers were actually computed off (`power`/`hr`/`mixed`/`null`, read from the already-computed `zone_distribution_7d.zone_basis`). For a power-less run these diverge: prescription `pace`, analysis `hr`. `latest.json` schema bumps v2 -> v3 (discard-and-resync). No ported metric math changes.
