---
"@enduragent/kernel": patch
---

Add the local-first athlete store's schema v1 as a single numbered migration
(Domains A–H) shipped bundled-as-string behind an ordered migration list on a
new store/migrations subpath, with a migration-executes-and-is-FK-consistent
test gate. Private-package infrastructure; ships nothing to users.
