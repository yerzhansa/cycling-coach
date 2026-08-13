---
"cycling-coach": patch
---

User-facing: Enduragent now opens normally when Telegram setup is left in an uncertain state after a crash or forced quit; the Telegram section shows a repair prompt instead of the whole app refusing to start.

Startup no longer throws when the initial Telegram reconciliation returns a non-applied outcome. The channel is latched into its existing failed/repair status until a successful reconcile or a daemon rebind clears it, and unexpected startup failures are now written to log.jsonl as a classified startup_failed record before any dialog.
