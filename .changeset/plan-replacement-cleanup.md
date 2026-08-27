---
"@enduragent/kernel": patch
"@enduragent/engine": patch
"@enduragent/coach-contract": patch
"@enduragent/coach": patch
"@enduragent/desktop-renderer": patch
---

Replace an active Plan atomically while preserving today, verify tomorrow-onward cleanup of the old Plan before writing the replacement’s next seven days, and keep failures recoverable after relaunch.
