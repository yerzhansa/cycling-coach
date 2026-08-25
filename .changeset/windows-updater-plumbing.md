---
"@enduragent/desktop": patch
---

Wire Windows updater plumbing: platform-gated update eligibility with Windows present but inactive, disableWebInstaller on the updater, and a pure N-to-N+1 Windows updater round-trip verifier with a negative-scenario harness. Windows update activation and Authenticode publisher checks stay pending until the first signed release.
