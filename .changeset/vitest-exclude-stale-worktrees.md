---
"@enduragent/core": patch
---

Scope the root test runner's collection to the project tree so stale agent
worktrees under `.claude/` are no longer crawled. The root vitest config now
extends vitest's default `exclude` with `**/.claude/**`, so the throwaway copies
of the suite that live in agent scratch worktrees stop being collected — they had
been amplifying a known load-dependent flake and adding spurious failures (one
worktree also carried a missing build artifact). The real suite is unchanged.

Pure dev-tooling change — athletes don't notice.
