---
"@enduragent/core": patch
---

Vendored the ChatGPT-subscription ("openai-codex") provider in-house and removed the `@mariozechner/pi-ai` dependency. OAuth login + token refresh, the Responses-API round-trip, the JWT account-id helper, and the per-million pricing catalog now live under `packages/core/src/agent/codex/`, re-expressed in the codebase's own AI-SDK type vocabulary (`ModelMessage[]` / `LanguageModelUsage`). Behavior is preserved — SSE transport, one request attempt with structured errors propagated to the shared retry layer, and native token-endpoint redaction (status + boolean field-presence only, never token bodies). No user-visible change.
