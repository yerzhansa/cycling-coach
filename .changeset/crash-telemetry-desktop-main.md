---
"@enduragent/desktop": patch
---

Log renderer and child-process crashes from the desktop main process and start Electron's crash reporter with local-only minidumps (`uploadToServer: false`). Fields are collapsed to one stderr line, query strings and fragments are dropped from the crashed URL, and oversized values are truncated.
