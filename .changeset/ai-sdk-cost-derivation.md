---
"cycling-coach": patch
---

Derive per-call cost for the AI-SDK providers (anthropic/openai/google) in the LLM dispatch chokepoint, so the local usage ledger's cost column is populated for them — previously only the codex path carried a cost. Cost is computed from the maintained model-pricing catalog (`pi-ai`'s `calculateCost`), the same catalog the codex path already prices against. The codex path keeps its own provider-reported cost and is never re-priced, and an uncatalogued model leaves cost undefined rather than fabricating a figure.
