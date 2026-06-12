---
"@enduragent/core": patch
"cycling-coach": patch
---

User-facing: Fixed the default Google model: setups that never chose a model now use gemini-2.5-flash, replacing the retired gemini-2.0-flash that made the coach fail to respond.

The google provider's hardcoded default pointed at gemini-2.0-flash, retired
by Google on 2026-06-01, so env-only deployments hard-errored on every call.
CONTEXT_WINDOWS gains a gemini-2.5-flash entry (1,000,000) so the model
resolves its real window instead of the 200,000-token fallback.
