---
name: verify-enduragent
description: Verify affected Enduragent desktop behavior through isolated fixtures and existing executors. Use for desktop verification or UI QA; currently maps Chat and past-chat history.
---

# Verify Enduragent

Verify only mapped, affected desktop behavior. Read repository instructions and [`references/features/README.md`](references/features/README.md), then read the selected feature page.

## Rules

- Preserve executor ownership; Playwright, Vitest, CDP, S8a, and manual checks are siblings.
- Never drive the operator's profile, athlete home, credentials, or production data.
- Rebuild dependencies, renderer, and desktop before Electron integration tests.
- Run deterministic citations before live flows.
- Treat the fixture's `finally` cleanup as mandatory; never kill processes by name.
- Report `passed`, `failed`, `blocked`, or `verified-unreachable`, with a concrete prerequisite for the last status.

## Prepare

```bash
pnpm --filter '@enduragent/desktop^...' build
pnpm --filter @enduragent/desktop-renderer build
pnpm --filter @enduragent/desktop build
```

If a build fails, stop with the failed command. Do not drive stale `dist/` or `out/` output.

## Verify

Follow the exact commands and proof requirements on the selected feature page. For Playwright, retain its failure screenshot, trace, and log under `apps/desktop/test-results/e2e/`; a passing run is supported by its visible-state assertions and command result.

Finish with `pnpm check:fixture-privacy`. Confirm the Electron fixture closed and report any retained evidence path. Do not upload evidence.
