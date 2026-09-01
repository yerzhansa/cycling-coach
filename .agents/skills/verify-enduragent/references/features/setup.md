# Setup

## Sub-features

- `settings.setup.inventory`: required full-window gate and Setup-first Settings projection; citation `apps/desktop-renderer/tests/onboarding-setup-card.test.tsx`.
- `settings.providers.lanes`: production-reported coach choices with the current lane identified; citation `apps/desktop-renderer/tests/onboarding-setup-card.test.tsx`.
- `training.setup.intervals-clipboard-connect` and `training.setup.file-import-fallback`: copied-key connection or local ride import; citation `apps/desktop-renderer/tests/onboarding-setup-card.test.tsx`.
- `settings.setup.readiness-gate`, `training.setup.readiness-sources`, and `training.setup.readiness-recovery`: provider, durable training data, and saved intake control readiness and recovery; citations `apps/desktop-renderer/tests/onboarding-setup-card.test.tsx` and `apps/desktop-renderer/tests/setup-readiness.test.tsx`.

Fixture profile: `first-run`. Deterministic placements: `gate` and `settings` from `apps/desktop-renderer/tests/onboarding-harness.tsx`. Supported executors: renderer `vitest` and the macOS Electron CDP fixture.

## How to get to it (user POV)

- Launch Enduragent before Setup is complete or when credential repair is required; the full-window Setup gate replaces app navigation.
- After Setup is complete, choose **Settings** in Main navigation; **Setup** is the first section.
- From a Coach or Training account recovery prompt in Settings, choose **Review setup** to focus that section.
- In the gate, choose what powers the coach, connect Intervals.icu or import ride files, answer injury status, then choose **Start coaching**.

## Driving it with verify-enduragent

```bash
pnpm --filter @enduragent/desktop-renderer exec vitest run tests/onboarding-setup-card.test.tsx tests/setup-readiness.test.tsx tests/onboarding-completion.test.ts
```

After the skill's Prepare build, run the macOS `first-run` CDP fixture with `pnpm --filter @enduragent/desktop exec vitest run tests/onboarding-first-run.integration.test.ts`.

Require `3 of 3 required ready`, enabled **Start coaching**, a persisted completion marker, gate removal, restored navigation, enabled Chat, and ready Training with a visible recent ride.

## Gotchas

- Install workspace dependencies and build missing renderer dependencies with `pnpm --filter '@enduragent/desktop-renderer^...' build` before renderer Vitest. The CDP fixture requires macOS, loopback access on `127.0.0.1`, and the skill's full Prepare build.
- The deterministic fixtures use mocked bridges and no real credentials. A real Intervals.icu connection requires its API key copied to the clipboard; the fallback requires local FIT, TCX, or GPX files.
- No Setup-owned Playwright flow exists. `apps/desktop/tests/e2e/desktop-launch.spec.ts` only proves isolated shell launch, not Setup behavior.
