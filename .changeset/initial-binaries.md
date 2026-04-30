---
"cycling-coach": minor
"running-coach": minor
"duathlon-coach": minor
---

Initial Wave 3 release with multi-package architecture. Cycling-coach binary now bundles via tsup (Wave 2's runtime resolution bug is fixed by externalizing @enduragent/* and letting npm dedupe at install). Running-coach and duathlon-coach are alpha placeholders.
