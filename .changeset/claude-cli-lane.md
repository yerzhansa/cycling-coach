---
"cycling-coach": minor
---

User-facing: Added a Claude subscription provider that drives your locally installed Claude Code CLI (bring your own login, no API key).

The lane runs the user-installed CLI as a model transport under the existing coach loop: one query per generation, tools served over an in-process MCP server, sanitized child env, and a persisted session cursor that falls back to a rebuild from our canonical transcript whenever it drifts. A three-layer kill switch (`ENDURAGENT_CLAUDE_CLI_DISABLED`, `llm.claude_cli.enabled: false`, desktop eligibility) is re-checked every turn, so disabling it takes effect on the next turn without a restart. macOS and Linux only this wave; Windows is unsupported for this lane.
