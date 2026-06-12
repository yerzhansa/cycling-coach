---
"@enduragent/core": patch
---

Wired a workspace-wide typecheck gate into `pnpm check`: the aggregator now runs the per-package `tsc --noEmit` checks plus a new root `check:types` leg (`tsconfig.check.json`) covering `tools/` and `packages/*/tests/`, and all pre-existing type errors were paid down behavior-preservingly (test-side casts/annotations, restored exhaustiveness guards in the Reference layer's sync reply formatter, an explicit type argument on the scheduler's persisted-state read, and a real bigint mtime assertion in the sanitize CLI test). Pure dev-time infra — athletes don't notice.
