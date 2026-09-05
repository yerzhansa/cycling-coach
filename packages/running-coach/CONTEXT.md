# Running Coach (binary)

A small shim that wires the running sport (`@enduragent/sport-running`) and the running binary config into Core's `runBinary` entry-point. No `onStartup` hook — running is a fresh sport with no legacy memory sections to migrate (unlike cycling).

## Status: wired, private (unpublished)

The [entry point](./src/index.ts) calls `runBinary(runningSport, runningBinary)` and reports fatal errors using the binary’s data directory. The [build configuration](./tsup.config.ts) explicitly externalizes `@enduragent/*`, so the output requires workspace dependencies at runtime.

This establishes source wiring and build intent, not a verified end-to-end coaching session. The package remains private. Publication would require a separate packaging decision and verification that installation works without private workspace packages.

## What lives here

- `src/index.ts` — the bin shim (`runBinary(runningSport, runningBinary)`).
- `src/binary.ts` — `runningBinary: BinaryConfig` (binaryName: "running-coach", displayName: "Running Coach", dataSubdir: "running", keychainPrefix: "running-coach", homeEnvVar: "RUNNING_COACH_HOME").
- `tests/binary.test.ts` — asserts the `BinaryConfig` shape, the running sport ID, and that `runBinary` is a function; it does not invoke the binary.

## Not here (intentionally)

Pace zones, critical-speed math, soul + skills, the `calculate_zones` tool — those live in `@enduragent/sport-running`. This package is the deployment shell only.
