# Training

## What it covers

- Owned user route: **Training** in Main navigation (`activeView: "training"`). Manifest surfaces: `training-setup`, `first-sync`, `training-import`, `training`, `ride-review`, `power-progress`, `wellness`, `training-export`, and `training-sync`.
- Setup and first sync: `training.setup.intervals-clipboard-connect`, `training.setup.file-import-fallback`, `training.first-sync.provider-backfill`, and `training.first-sync.failure-recovery`.
- Resident overview and recovery: `training.view.panel-inventory`, `training.view.readiness-states`, `training.view.context-recovery`, `training.view.anchor-load-plan-adherence`, `training.power-progress.comparison`, and `training.wellness.trend`.
- Ride review, import, export, and sync: `training.ride-review.navigation`, `training.ride-review.local-analysis`, `training.import.progress-results`, `training.export.activity-formats`, `training.export.workout-formats`, `training.sync.lifecycle`, and `training.sync.protocol-failure`.

Fixture/profile: isolated renderer `ready()` state with shifted fixture dates and no athlete profile or credentials. Supported executors: renderer and desktop `vitest`; native Windows scenarios remain `vm-only`.

## How to get to it (user POV)

- Complete Setup, then choose **Training** in Main navigation.
- Use **Sync now** or **Import ride files**, open a ride from **Recent rides** for **Ride review**, and use **Back to training** to return with focus restored.
- Export a reviewed ride as FIT or GPX, or export the visible planned workouts as a ZWO, MRC, ERG, or FIT archive.

## Driving it with verify-enduragent

```bash
pnpm --filter @enduragent/desktop-renderer exec vitest run tests/training-surface.test.tsx tests/training-context.test.ts tests/training-sync.test.ts tests/training-export.test.ts
pnpm --filter @enduragent/desktop exec vitest run tests/windows-parity-scenarios.test.ts
```

Require the renderer run to show the **Training** region and shipped panel order, truthful loading and failure states, context recovery, sync retry and protocol handling, import progress, ride-review navigation, and ride/workout export requests. Require the desktop run to validate the frozen Training manifest and its deterministic citations; it does not execute the mapped behavior.

## Gotchas

- Setup must be complete before Main navigation is available; use the Setup feature page for the `training-setup` surface.
- Renderer tests use isolated state and mocked actions. They do not exercise real credentials, provider data, native file dialogs, or an installed application.
- `training.windows.ride-import-copy`, `training.windows.ride-import-native`, and `training.windows.export-native` require an installed Windows VM and have no deterministic citations.
- No Training-owned Playwright, CDP, S8A, or other live-driver flow is proved by the mapped Training tests or fixture.
