# snapshot-section-11

Oracle generator for the section-11 → TypeScript metric port. Runs the
section-11 Python coaching protocol against a checked-in golden fixture
via [pyodide](https://pyodide.org) and writes every per-metric output to
`packages/core/tests/fixtures/snapshots/<athlete>/<metric>.json` plus a
top-level `manifest.json`.

**Methodology**: characterization + differential testing. The upstream
Python is the source of truth; we transcribe its outputs here so future
TS metric ports have something to assert against. This script does not
itself assert parity — parity tests ship with F8+ alongside each TS
metric.

## Quick start

```bash
pnpm snapshot:section-11
```

Pre-requisites:

- `pnpm install` has run (pyodide pulled into `node_modules`).
- A section-11 checkout is reachable. Defaults to `../section-11`;
  override with `SECTION_11_REPO=/abs/path pnpm snapshot:section-11`.

The script is **offline-safe**: pyodide loads from `node_modules/pyodide`
and `requests` is replaced with an in-process stub before `sync.py`
imports. No network calls are made.

## What it writes

```
packages/core/tests/fixtures/snapshots/
├── manifest.json
└── realistic-athlete/
    ├── acwr.json
    ├── monotony.json
    ├── strain.json
    ├── ... (52 per-metric files)
    └── zone_distribution_7d.json
```

Each per-metric file:

```json
{
  "metric": "acwr",
  "athlete": "realistic-athlete",
  "section_11_sha": "224c369d2f14a71725cb9157fc133cf3cff5cd32",
  "section_11_protocol_version": "3.112",
  "frozen_now": "2026-05-10T12:00:00",
  "value": 0.81
}
```

`value` is the section-11 output verbatim — scalar for simple metrics,
nested object for compound ones like `capability` or `phase_detection`.
A `null` value means section-11 itself returned `None` (often because
the direct-call path doesn't currently supply stream-derived inputs;
see "Known gaps" below).

The manifest pins the oracle:

```json
{
  "section_11_sha": "224c369d2f14a71725cb9157fc133cf3cff5cd32",
  "section_11_protocol_version": "3.112",
  "capture_date_utc": "2026-05-21T04:42:19.005Z",
  "fixtures": ["realistic-athlete"],
  "metrics": [ ... 52 names ... ],
  "pyodide_version": "0.29.4",
  "frozen_now": "2026-05-10T12:00:00",
  "offline_mode": "A_stub_requests_plus_monkey_patch"
}
```

## When to regenerate

Regenerate (`pnpm snapshot:section-11` + commit the diff) whenever any
of these change:

1. **section-11 SHA bump.** `git -C ../section-11 pull`, then re-run.
   The manifest's `section_11_sha` will diff; review the per-metric
   value diffs alongside it before committing — those diffs ARE the
   upstream-change signal.
2. **New golden fixture** is added under `packages/core/tests/fixtures/golden/`.
   Extend the harness's fixture list (currently a single hardcoded
   slug) to capture against the new athlete.
3. **`FROZEN_NOW` is moved.** The clock anchor is currently a
   script-level constant; bumping it shifts every rolling-window
   metric. Coordinate with the PR description.
4. **pyodide version bump.** Verify the manifest's `pyodide_version`
   reflects the new install, then re-run.

## Offline-mode choice — Option A

The handoff brief offered three approaches for the section-11 HTTP
boundary:

- **A. Stub `requests` in pyodide before `sync.py` loads.** Patch
  `requests.get`/`post`/etc. to return inert responses; the metric
  computation path doesn't actually call them (it goes through
  `_calculate_derived_metrics` directly), so the stubs satisfy the
  module-level `import requests` and nothing more.
- **B. Fork the metric functions** into a stripped-down extracted
  Python module that takes pre-fetched JSON as input. Rejected:
  loses upstream-tracking fidelity (a section-11 SHA bump in any
  ancillary helper used by `_calculate_derived_metrics` would need
  to be replayed by hand).
- **C. Inject `requests` into `sys.modules` via pyodide.** Effectively
  the same as A; A is the implementation chosen.

**Chosen: A.** It is the minimal-fidelity-loss option that runs against
the upstream source verbatim. The metric path is invoked by calling
`IntervalsSync._calculate_derived_metrics` directly with arguments
constructed from the golden fixture, so the HTTP stub never actually
fires — it exists only to satisfy `import requests` at module load
time. See "Known gaps" for what the direct-call path skips.

## Known gaps

The direct-call path bypasses the orchestration in
`collect_training_data` and its upstream fetchers. The following
inputs to `_calculate_derived_metrics` come in as `None`/empty in
this harness:

- `power_curve_data`, `power_curve_dates` — would normally come from
  `_intervals_get("power-curves", ...)`. Affects
  `capability.power_curve_delta`.
- `hr_curve_data` — affects `capability.hr_curve_delta`.
- `sustainability_curves` — affects `capability.sustainability_profile`.
- `self._intervals_data` — populated by `_generate_intervals()` in the
  live pipeline; affects `capability.dfa_a1_profile`.
- `vo2max`, `power_model` — come from `_fetch_today_wellness()`;
  affects `eftp`, `w_prime`, `w_prime_kj`, `p_max`, `vo2max`,
  `power_model_source`.
- `race_calendar` — affects phase-detection's `race_proximity` slot.
- `formatted_planned_workouts`, `past_events` — affect Consistency
  Index, phase-detection's stream_2 plan-coverage slots.
- `sport_settings` — affects FTP-dependent zone-basis selection.
- `benchmark_indoor`, `benchmark_outdoor` — passed as `(None, None,
  None)`. Affects `benchmark_indoor`/`benchmark_outdoor` outputs.

In addition, some metric names are emitted by `collect_training_data`
itself (the orchestrating method that wraps `_calculate_derived_metrics`)
and are therefore **absent entirely** from this snapshot set, not merely
null:

- `ramp_rate` — derived by `collect_training_data` from wellness data
  (api `rampRate` + decay smoothing, see `sync.py` around line 2399 and
  the emit at line 2674). Bypassed by the direct-call path. Tracked as
  a follow-up: the harness either needs to call `collect_training_data`
  end-to-end (with a fixture-mapped `_intervals_get` stub) or expose
  `ramp_rate` via an additional capture site.

These gaps are intentional for the first oracle pass. Future waves
will either (a) extend the harness to invoke `collect_training_data`
end-to-end with a richer fixture-mapped `_intervals_get` stub, or
(b) extend the fixture format to ship pre-aggregated stream-derived
inputs. The snapshot baseline locks in "given these inputs, these
metrics are null" — which is itself a useful regression signal.

## Null / absent audit (against F8 metric scope)

Audit run 2026-05-21 against the realistic-athlete snapshot set
generated from `section_11_sha = 224c369d`.

**Null-value snapshots (7):**
`consistency_index`, `eftp`, `p_max`, `power_model_source`, `vo2max`,
`w_prime`, `w_prime_kj`. All are deferred to F10 (capability/stream
metrics) or follow-on F8 wiring — none of them are in F8's load-management
scope.

**Absent-from-output (1):**
`ramp_rate`. Emitted only by `collect_training_data`, not by the
direct-call path used here. F8 metric — needs the harness invocation
path fix listed above before T12 can port it.

**F8 metric coverage (6 of 7 populated, 1 absent):**

| F8 metric | Status | Snapshot value |
| --- | --- | --- |
| `acwr` | populated | 0.81 |
| `monotony` | populated | 0.97 |
| `strain` | populated | 249 |
| `recovery_index` | populated | 0.91 |
| `stress_tolerance` | populated | 2.6 |
| `load_recovery_ratio` | populated | 2.8 |
| `ramp_rate` | **absent** | — (gap above) |

## Frozen clock

`FROZEN_NOW = "2026-05-10T12:00:00"` is hardcoded in the harness.
Rationale: the realistic-athlete fixture's last activity is 2026-05-09;
anchoring "now" to one day later puts the activity within the 7-day
ACWR window and gives every rolling metric non-trivial input. If the
fixture is re-sanitized with a different date range, move this
constant in lockstep.

## Adding a new athlete

Today the harness has a single hardcoded slug (`realistic-athlete`).
To capture a second fixture (e.g., `post-break-resume`, `zero-activities`):

1. Add the slug to a `FIXTURES` array in `tools/snapshot-section-11.ts`
   (replace the hardcoded `ATHLETE_SLUG`/`FIXTURE_REL` constants).
2. Re-run `pnpm snapshot:section-11`. The script will create one
   subdirectory per slug and one combined `manifest.json`.

The 3-golden cap from `packages/core/tests/fixtures/README.md` applies
— don't sprawl. Synthetic regression fixtures get their own targeted
snapshot test, not a full per-metric capture.

## Why pyodide and not subprocess Python

The architect review (`docs/initiatives/section-11/learnings/`,
local-only — see PR body for the path) calls out two requirements:

1. **No system Python dependency for CI / contributor reproducibility.**
   Pyodide is a Node devDependency, so the harness runs anywhere
   `pnpm install` works.
2. **Bit-identical output to upstream.** Pyodide ships CPython compiled
   to WebAssembly with the standard library intact. `statistics.stdev`,
   `math.sqrt`, IEEE-754 arithmetic — all identical to running on a
   system Python. The `requests` module is stubbed, but the stub never
   fires on the direct-call path.

5MB pyodide bundle is acceptable as a devDependency; it never ships
to athletes.
