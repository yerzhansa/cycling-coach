---
"@enduragent/desktop": patch
---

Windows release upload: uploads read-only copies of the exact verified bytes and reconciles GitHub asset digests against them, verifies the packaged `app-update.yml` publisher and seals its digest into the installer provenance, and refuses uploads to a release that is not the repository's latest.
