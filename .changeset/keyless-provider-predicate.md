---
"cycling-coach": patch
---

User-facing: Fixed season review failing with a "Configured model credentials are unavailable" error when using the Claude CLI provider.

The keyless-provider test was hand-written as a two-arm disjunction in a dozen places, and the season review guard only ever knew about the older keyless lane, so it demanded an API key from every Claude CLI athlete. The predicate now lives once in the contract package as `KEYLESS_LLM_PROVIDERS` / `isKeylessProvider`, is re-exported from the core runtime config for core, coach and desktop consumers, and a source-level assertion keeps the disjunction from being written by hand again.
