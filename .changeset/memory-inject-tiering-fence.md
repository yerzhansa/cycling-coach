---
"cycling-coach": patch
---

User-facing: Long-term memory no longer crowds out conversation history — only your core profile is pinned into every reply, and the coach fetches the rest on demand.

Tier memory injection so only always-inject sections (person, goals, preferences, medical history, schedule, and the sport profile) render into the system prompt's athlete context; notes, equipment, and history stay on disk and remain reachable through the memory read tool. Add a prompt-layer section budget that nudges the flush pass to move dated detail into daily notes instead of growing a section, and hard-cap the rendered athlete context with a disclosed, warned truncation. Harden the athlete-data fence: a new reusable prompt-fence module neutralizes fence tokens and strips control/format characters, and every tool result is marked as untrusted data at a single choke point so stored or external text can never escape its fenced block.
