---
"cycling-coach": minor
---

First release after the Core/Sport seam refactor (issue #47). cycling-coach is now bundled via tsup — `@enduragent/core` and `@enduragent/sport-cycling` are inlined into the binary's `dist/index.js` rather than being declared as runtime dependencies. End users continue to install a single npm package; the workspace split is invisible to them. Stub binaries (`running-coach`, `duathlon-coach`) and library packages (`@enduragent/*`) are private and not published — they will be published when the first external consumer needs them. See ADR-0010.
