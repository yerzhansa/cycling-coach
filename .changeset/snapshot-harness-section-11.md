---
"@enduragent/core": patch
---

Section-11 snapshot harness — pyodide-driven oracle generator for the Reference metric port.

- Added `tools/snapshot-section-11.ts` (root script: `pnpm snapshot:section-11`). Runs the section-11 Python `_calculate_derived_metrics` against a checked-in golden fixture via pyodide and writes every per-metric output to `packages/core/tests/fixtures/snapshots/<athlete>/<metric>.json` plus a top-level `manifest.json` pinning the upstream SHA, protocol version, pyodide version, and frozen-clock anchor.
- Offline-safe via Option A (stub `requests` module + invoke `_calculate_derived_metrics` directly with fixture-constructed args). No network calls; pyodide's stdlib delivers bit-identical IEEE-754 math to upstream.
- Captured 52 metrics from the `realistic-athlete` fixture against section-11 SHA `224c369d` (protocol v3.112). Per-metric files are the oracle that future TS metric ports (F8+) will assert against — this PR ships the harness only, no parity assertions.
- One Vitest smoke test (`reference-metrics-snapshot-loop.test.ts`) proves the snapshot is loadable and the manifest pins what it claims to pin.
- pyodide v0.29.4 added as a root devDependency (~5MB; never ships to athletes).

Pure-infra changeset.
