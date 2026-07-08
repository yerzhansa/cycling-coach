---
"@enduragent/core": patch
---

Route the CLI REPL and the Telegram channel through an in-process engine seam
(createCoachEngine) that delegates verbatim to the coaching agent. Pure
wiring refactor: no behavior change, proven by the replay gate's zero-diff
baseline and the untouched channel test suites.
