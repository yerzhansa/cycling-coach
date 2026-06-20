---
"@enduragent/core": patch
---

User-facing: A single server hiccup or network blip from the AI provider no longer ends your turn — the coach now retries briefly and keeps going.

Both the AI-SDK and codex provider paths now route transient 5xx/network failures through one closed error taxonomy and a single jittered-retry layer; a connection-refused error buried on `error.cause` is detected via a cause-chain walk. The codex provider path stops mis-classing a transient gateway 5xx as a rate limit (it took 5-35s of rate-limit-grade backoff it did not deserve) and now honors Retry-After from the response headers; a runtime-fetch wrapper stops the provider library's internal network-retry loop so network errors are retried at exactly one layer, and a static-dist smoke test trips loudly if a provider-library upgrade renames the no-retry marker.
