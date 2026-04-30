# Cycling Coach (binary)

The published `cycling-coach` npm binary. A 7-line shim that wires the cycling sport (`@enduragent/sport-cycling`) and the cycling binary config to Core's `runBinary` entry-point. Includes the legacy-section migration as an `onStartup` hook so existing users with `~/.cycling-coach/memory/MEMORY.md` get their `profile`/`equipment`/`health` sections renamed to `cycling-profile`/`cycling-equipment`/`cycling-history` on first launch.

## Status: published

Bundled via tsup with `@enduragent/*` externalized — npm dedupes Core and sport-cycling at install time, fixing Wave 2's runtime resolution bug. CalVer scheme (`YYYY.M.D[-N]`) continues; library deps follow SemVer.

## What lives here

- `src/index.ts` — the bin shim (`runBinary(cyclingSport, cyclingBinary, { onStartup })`).
- `src/binary.ts` — `cyclingBinary: BinaryConfig` (binaryName: "cycling-coach", displayName: "Cycling Coach", dataSubdir: "cycling", keychainPrefix: "cycling-coach", homeEnvVar: "CYCLING_COACH_HOME").
- `tests/migration-integration.test.ts` — end-to-end check that the legacy-section migration runs through `agent.getMemory()` exactly as `runBinary`'s onStartup does.
- `Dockerfile` — multi-stage workspace build via `pnpm deploy --prod`. Railway picks this up.

## Not here (intentionally)

Sport vocabulary, FTP math, intervals.icu workouts, soul + skills — those live in `@enduragent/sport-cycling`. This package is the deployment shell only.
