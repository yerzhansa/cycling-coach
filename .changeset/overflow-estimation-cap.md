---
"cycling-coach": patch
---

User-facing: Long chats that hit the model's context limit now compact and retry to produce a complete answer instead of returning a cut-off reply.

Harden context-overflow classification, token estimation, and effective-window caps. Context-overflow classification now recognizes structured provider signals (Codex-normalized `ContextOverflowError`, and 400 responses whose body carries a known overflow code or message) on top of the existing message fallbacks, without treating every 400 as overflow. A successful `length` finish whose prompt already filled the real provider window is routed through the existing compaction rescue rather than persisting the truncated text; plain output-length truncation keeps the earlier empty-reply recovery. Token estimation counts part-array/structured message content instead of dropping it to zero and can anchor budget math to the provider's reported token usage. History budget, preemptive compaction, and compaction chunk sizing use a 200,000-token effective estimator window (`min(providerWindow, 200k)`) so a million-token provider window no longer expands the planning target.
