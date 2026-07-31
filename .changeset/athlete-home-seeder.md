---
"@enduragent/kernel-node": patch
---

Add the per-athlete store-home resolver (the one-athlete `store`/`archive`/`config`
layout with an ENDURAGENT_HOME override) and an idempotent FTP-history seeder that
maps legacy per-binary FTP history into cycling anchor rows, insert-if-absent by
(sport, anchor type, effective date), and no-ops cleanly on the empty-on-real-install
case.
