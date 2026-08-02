---
"cycling-coach": minor
---

User-facing: Experimental (off by default): a Codex provider that drives your locally installed, ChatGPT-signed-in codex CLI as the coaching agent. Enable it in config.yaml with llm.provider: codex-agent and llm.codex_agent.enabled: true.

Config-file only — deliberately absent from the setup wizard, the model catalogue and the desktop onboarding UI, so it can only be reached by editing `config.yaml`. macOS and Linux only; win32 is refused before the enabled check so a Windows user gets the accurate message.

Architecturally this is agent delegation rather than CLI-as-transport: `turn/start` runs Codex's own agentic loop, the 18 coaching tools are injected over a loopback MCP endpoint, and the coach persona is applied as developer instructions rather than as a system prompt. One coaching turn is one billed call against the subscription regardless of how many model calls Codex makes internally, so every ledger row is stamped notional and excluded from the spending cap.

Safety posture: the child environment is allowlist-built from an empty object rather than filtered from the parent, `account/read` must report a ChatGPT account on every turn-carrying child and not just the cached readiness census, the model provider and endpoint are pinned, and the user's own `~/.codex/config.toml` MCP servers, plugins, hooks, shell execution, multi-agent, browser use and web search are all disabled for the duration of a coaching turn. Verification reads the effective config back from the spawned child and refuses rather than degrading. No CLI binary is bundled and no native module is added — the user installs `codex` and signs in themselves.
