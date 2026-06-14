---
"cycling-coach": patch
---

User-facing: Lower per-message API cost on the default Anthropic model by caching the stable system prompt and tool definitions across a turn.

Sets an ephemeral cache breakpoint on the last stable system block in the LLM dispatch chokepoint, so multi-step tool turns and the memory-flush prompt re-read the system + tool prefix at cache-read rates instead of full price. The system prompt is reordered so all static rule blocks form one frozen prefix ahead of a cache-boundary marker, with the volatile Athlete Context and time-zone blocks last, so a memory write no longer invalidates the cached prefix. Corrects two comments that wrongly claimed caching was already active.
