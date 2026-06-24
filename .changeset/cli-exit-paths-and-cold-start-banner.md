---
"@enduragent/core": patch
---

User-facing: /quit, /exit, and Ctrl-D now exit cleanly, and startup shows a "syncing training data" line (with an explanation if the first sync fails).

The CLI readline loop registers a single close handler that stops the periodic Reference sync scheduler and exits with code 0, so /quit, /exit, Ctrl-D, and a single Ctrl-C at the prompt all return the athlete to their shell instead of leaving a zombie process syncing under their API key. A verbatim banner prints before the awaited boot sync (in both CLI and Telegram modes) so the previously blank up-to-120s cold start is visible. A first sync that resolves failed (rather than throwing) is now surfaced with a one-line explanation from the Reference bootstrap. As defense-in-depth, the periodic scheduler timer is unref'd behind a guard so it cannot keep the process alive on its own.
