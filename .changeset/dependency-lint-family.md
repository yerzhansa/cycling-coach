---
"@enduragent/core": patch
"cycling-coach": patch
---

Parameterize per-binary environment variable names (setup/update/managed-deploy
knobs derive from the binary name instead of hardcoding one binary's prefix),
ship the MIT NOTICE file inside the published npm tarball, and arm the
package-dependency lint family with empty kernel package scaffolds.
