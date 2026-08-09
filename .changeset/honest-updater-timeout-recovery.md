---
"@enduragent/desktop": patch
"@enduragent/desktop-renderer": patch
---

User-facing: Desktop now asks you to quit and reopen the app after an update timeout instead of offering a retry that cannot run safely.

Invalidate timed-out updater generations, fence late completions, and keep automated and manual checks disabled until process restart because the native macOS updater does not expose a supported instance reset.
