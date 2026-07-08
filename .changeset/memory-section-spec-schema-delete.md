---
"@enduragent/core": patch
---

Remove the unimplemented `schema` field from `MemorySectionSpec`. No code ever
read it; section-name validation at the memory_write seams (Zod enum of
declared section names) is the actual enforcement surface.
