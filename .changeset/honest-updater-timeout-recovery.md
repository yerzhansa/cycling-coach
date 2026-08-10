---
"@enduragent/desktop": patch
"@enduragent/desktop-renderer": patch
---

User-facing: Desktop now asks you to quit and reopen the app when an update check cannot safely continue, instead of offering a retry that cannot run.

Invalidate timed-out updater generations, fence late completions, and keep automated and manual checks disabled until process restart after timeouts or updater startup failures because the native macOS updater does not expose a supported instance reset.
