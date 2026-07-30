---
"cycling-coach": patch
"@enduragent/core": patch
"@enduragent/coach": patch
"@enduragent/coach-contract": patch
"@enduragent/coach-client": patch
"@enduragent/desktop": patch
"@enduragent/desktop-renderer": patch
---

User-facing: Desktop now has a read-only Past chats page that lists every conversation kept when you started a new one, and lets you page back through its messages.

Adds boundary-scoped archived conversation reads (list plus a cursor-namespaced page reader) through the durable transcript store, daemon RPC registry, main-process IPC, and the validated preload bridge. Current-conversation hydration is untouched; the archived surface has no composer, retry, or resume path. Protocol version moves to 11 because the wire method set grew.
