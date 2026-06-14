---
"cycling-coach": patch
---

User-facing: Added an optional cheaper model for memory tidy-up (config `llm.flush_model` / env `LLM_FLUSH_MODEL`); unset keeps using your chat model.
User-facing: The first reply of the day and recovery from long conversations are faster — the bot no longer re-runs the memory tidy-up multiple times in one turn.

The memory tidy-up can now run on a configurable cheaper model via a second, lazily-built LLM while the chat reply keeps the default model; when unset it reuses the chat model (no change). A per-turn latch deduplicates the tidy-up to at most once per chat turn — the daily-reset tidy-up counts as the one, and the trim, over-budget, and overflow-recovery paths no longer re-run it. The tidy-up and compaction calls are now tagged in the local-only usage ledger so their cost is visible.
