# Running Coach (binary)

A small shim that wires the running sport (`@enduragent/sport-running`) and the running binary config into Core's `runBinary` entry-point. No `onStartup` hook — running is a fresh sport with no legacy memory sections to migrate (unlike cycling).

## Status: wired, private (unpublished)

Runs locally from the workspace. Unlike the published `cycling-coach`, this package **externalizes** `@enduragent/*` (tsup default) rather than bundling them: Core compiles to a single self-contained `dist/index.js`, so a private workspace package resolves Core and sport-running through pnpm's symlinks at runtime — no bundled tarball is built.

When it flips `private: false` to publish, it must switch to bundling (`noExternal`) to match cycling-coach — an externalized tarball would `import` the private, unpublished `@enduragent/core` and 404 on a fresh `npm install`. That transition is **mechanically enforced, not left to memory**: the release smoke job (`.github/workflows/release.yml`) packs the tarball and installs it into a fresh consumer, so a public flip without `noExternal` fails the smoke gate before publish. See ADR-0009/0010.

## What lives here

- `src/index.ts` — the bin shim (`runBinary(runningSport, runningBinary)`).
- `src/binary.ts` — `runningBinary: BinaryConfig` (binaryName: "running-coach", displayName: "Running Coach", dataSubdir: "running", keychainPrefix: "running-coach", homeEnvVar: "RUNNING_COACH_HOME").
- `tests/binary.test.ts` — asserts the BinaryConfig shape and that the running sport wires into `runBinary`.

## Not here (intentionally)

Pace zones, critical-speed math, soul + skills, the `calculate_zones` tool — those live in `@enduragent/sport-running`. This package is the deployment shell only.
