---
"@enduragent/desktop": patch
---

User-facing: Official Desktop releases now send a once-daily installation heartbeat containing only the fixed Enduragent Desktop product label, a random installation ID, app version, and platform. Set `ENDURAGENT_NO_USAGE_PING=1` before launch to disable it without disabling update checks.
