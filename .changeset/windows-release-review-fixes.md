---
"@enduragent/desktop": patch
---

Windows release lane: the uploader requires local Authenticode verification and a real publisher DN before any release mutation, records partially uploaded assets on failure, and refuses an upload record inside the artifact directory; the verification workflow runs on `windows-latest` and binds the installer's sealed release commit; the updater round-trip recomputes blockmap chunk checksums against the installer bytes.
