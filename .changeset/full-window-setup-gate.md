---
"@enduragent/desktop": patch
"@enduragent/desktop-renderer": patch
---

User-facing: Setup is now its own full-window screen that opens first and stays up until you answer all three required questions — what powers your coach, Intervals.icu, and your injury status. Telegram remains available there as an optional connection.

The desktop Shell renders the setup gate instead of the sidebar and views while setup is required, so the chat surface is unmounted rather than hosting an in-thread setup card. Credential repair stays reachable inside the gate through the shared credential feedback block.
