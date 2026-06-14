---
"@enduragent/core": patch
"cycling-coach": patch
---

User-facing: cycling-coach now requires Node.js 22 or newer.

The advertised runtime floor was raised from Node 20 (end-of-life
2026-04-30) to Node 22 across the workspace package manifests and the
install docs, matching the only Node versions any first-party runtime
(CI, the published Docker image, the release pipeline) actually uses.
