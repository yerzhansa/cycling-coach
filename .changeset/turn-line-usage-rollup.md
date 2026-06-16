---
"cycling-coach": patch
---

Record per-turn token usage and cost on the local usage-ledger turn line. The chat turn line previously carried only timing (`durationMs`); it now also folds in the winning generation's input/output/total tokens, cache read/write tokens, and cost, mirroring the per-generation line. v1 records the final successful generation's figures — not a sum across retry/compaction attempts — and a true turn-wide accumulator is deferred.
