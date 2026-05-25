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
├── realistic-athlete/
│   ├── acwr.json
│   ├── monotony.json
│   ├── strain.json
│   ├── ... (52 per-metric files)
│   └── zone_distribution_7d.json
├── new-athlete-empty/
│   └── ... (52 per-metric files, most `value: null` because no activities/wellness)
└── data-gap-mid-history/
    └── ... (52 per-metric files; ACWR is non-null because the resumed week populates the acute window)
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
  "section_11_commit_date": "2026-04-28T18:14:07+00:00",
  "fixtures": ["data-gap-mid-history", "new-athlete-empty", "realistic-athlete"],
  "metrics": [ ... 52 names — union across all fixtures ... ],
  "pyodide_version": "0.29.4",
  "frozen_now": "2026-05-10T12:00:00",
  "offline_mode": "A_stub_requests_plus_monkey_patch"
}
```

The `frozen_now` field carries the harness's default anchor. Per-fixture
overrides (e.g., `data-gap-mid-history` uses `2026-05-20T12:00:00` to
catch its resumed week in the acute window) are recorded in each
per-snapshot wrapper's `frozen_now` field, not in the manifest top-level.

`section_11_commit_date` is derived deterministically from the
section-11 SHA's commit object (`git show -s --format=%cI`). It
replaces the old wall-clock `capture_date_utc` field — that one
broke byte-identity across consecutive harness runs, see the
Determinism section below.

## When to regenerate

Regenerate (`pnpm snapshot:section-11` + commit the diff) whenever any
of these change:

1. **section-11 SHA bump.** `git -C ../section-11 pull`, then re-run.
   The manifest's `section_11_sha` will diff; review the per-metric
   value diffs alongside it before committing — those diffs ARE the
   upstream-change signal.
2. **New golden fixture** is added under `packages/core/tests/fixtures/golden/`.
   Add an entry to the `HARNESS_FIXTURES` allowlist in
   `tools/snapshot-section-11.ts` (slug + frozenNow + description) and
   re-run. Fixtures owned by other test suites (e.g., F7 reference
   substrate's `post-break-resume` and `zero-activities`) live in the
   same dir but are intentionally excluded from the harness — they
   don't conform to sync.py's input contract.
3. **A fixture's `frozenNow` anchor is moved.** Anchors live on each
   `HARNESS_FIXTURES` entry (with `DEFAULT_FROZEN_NOW` as the fallback);
   bumping one shifts every rolling-window metric for that fixture.
   Coordinate with the PR description.
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

- `ramp_rate` — emitted by `collect_training_data` from wellness data
  (intervals.icu's `rampRate` + decay smoothing, see `sync.py` around
  line 2399 and the emit at line 2674). **Intentionally not captured.**
  We decided not to port a `ramp_rate` metric at all: intervals.icu
  computes the value server-side and hands it to us finished, so there
  is no algorithm worth porting — the Reference layer consumes it
  directly as `weeklyFitnessChange` (the renamed input field) where a
  fitness-trend signal is needed. The harness deliberately stays
  direct-call-only and does NOT drive `collect_training_data`
  end-to-end. Decision recorded local-only; not a gap to close.

These gaps are intentional for the first oracle pass. The null-valued
inputs above (power/HR curves, `sustainability_curves`, `power_model`,
`vo2max`, etc.) are deferred to the capability/stream wave, which will
either extend the harness or extend the fixture format to supply them.
The one absent-entirely entry, `ramp_rate`, is NOT such a gap — that
metric is intentionally not ported (see above), so no harness extension
is planned for it. The snapshot baseline locks in "given these inputs,
these metrics are null" — which is itself a useful regression signal.

## Contract validation

`sync.py` reads fixture fields almost exclusively via `dict.get('foo')`,
which silently returns `None` on a missing key. A fixture with a typo'd
field name (`"activitiez"` instead of `"activities"`) would produce a
wrong-but-not-crashing snapshot, and the TS port would faithfully
assert against that wrong oracle. T06 closes this hole by wrapping
every dict that ultimately came from the loaded fixture in a
`_TrackedDict` that logs every `.get()` of an absent key. After
`_calculate_derived_metrics` returns, the harness checks the log; if
any unallowlisted access happened, it raises a structured error
listing each missing path and aborts the run.

Failure shape:

```
$ pnpm snapshot:section-11
[snapshot] section-11 sha=… protocol=… pyodide=…
Error: fixture/sync.py contract violation: 1 unique missing key(s)
read silently as None (1 total .get() accesses):
  - FIXTURE.activities

sync.py read None silently from fixture paths that don't exist.
Either fix the fixture to include the keys, or — if a key is
intentionally optional in the schema — extend the contract
allowlist in tools/snapshot-section-11.ts. See the README's
'Contract validation' section.
```

Allowlist semantics:

- The harness's Python prologue holds `_ALLOWED_OPTIONAL_PATHS`, a
  set of dotted paths with `[*]` as the array-index wildcard.
- A missing key whose normalized path is in the allowlist is
  treated as a per-record optional field — `sync.py` is expected
  to handle None there, and the absence is part of the schema's
  contract.
- A missing key not in the allowlist is a contract violation and
  fails the run.

Initial allowlist (intervals.icu fields that may legitimately be
absent on a per-record basis — old activities computed before the
field existed, rest-day wellness entries with no Fitness/Fatigue,
etc.):

```python
_ALLOWED_OPTIONAL_PATHS = {
    "FIXTURE.activities[*].icu_hr_decoupling",
    "FIXTURE.activities[*].icu_hr_zone_times",
    "FIXTURE.activities[*].icu_hrr",
    "FIXTURE.activities[*].icu_variability_index",
    "FIXTURE.wellness[*].atl",
    "FIXTURE.wellness[*].ctl",
}
```

Extending the allowlist requires a README update in this section so
the reviewer can trace why a particular field is treated as
schema-optional.

Tested by `packages/core/tests/snapshot-contract.test.ts`, which
deliberately renames `"activities"` to `"activitiez"` in a temp
fixture, runs the harness against it, and asserts the structured
failure surfaces the renamed path.

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
direct-call path used here. **Intentionally not captured** — the
`ramp_rate` metric is not ported (intervals.icu computes it; the
Reference layer consumes `weeklyFitnessChange` directly). Not a gap
to close; see "Known gaps" above.

**F8 metric coverage (6 metrics — `ramp_rate` dropped, not ported):**

| F8 metric | Status | Snapshot value |
| --- | --- | --- |
| `acwr` | populated | 0.81 |
| `monotony` | populated | 0.97 |
| `strain` | populated | 249 |
| `recovery_index` | populated | 0.91 |
| `stress_tolerance` | populated | 2.6 |
| `load_recovery_ratio` | populated | 2.8 |
| `ramp_rate` | **not ported** | — (sourced from intervals.icu) |

## Determinism

The harness aims for **byte-identical output across consecutive runs**
given the same inputs (fixture, section-11 SHA, pyodide version,
`FROZEN_NOW`). This invariant is enforced by
`packages/core/tests/snapshot-determinism.test.ts`, which runs the
harness twice into temp directories and `diff`s the trees.

Sources of potential non-determinism that have been audited and
pinned:

- **`datetime.now()`** — frozen to `FROZEN_NOW` (see "Frozen clock"
  below). Without this, every rolling-window metric drifts.
- **Manifest `section_11_commit_date`** — derived deterministically
  from the section-11 SHA's commit object (`git show -s
  --format=%cI`). The pre-pinning manifest carried a wall-clock
  `capture_date_utc = new Date().toISOString()`, which made two
  back-to-back runs diff on the manifest line. Replaced.
- **JSON output ordering** — `json.dumps(..., sort_keys=True)` in
  the Python prologue + `JSON.stringify(wrapper, null, 2)` with
  insertion-ordered keys in the TS writer. Both stable.
- **Dict iteration order** — CPython 3.7+ uses insertion order;
  pyodide ships CPython 3.x with the same guarantee.
- **`set()` iteration** — section-11's `_calculate_derived_metrics`
  does not iterate unordered sets in a way that reaches output
  surface (audited 2026-05-21 against SHA `224c369d`). If a future
  SHA bump introduces one, the determinism test will surface it.
- **`PYTHONHASHSEED`** — pyodide does not honor the env var the way
  CPython does, but the same audit confirms no dict iteration order
  reaches the output. Re-verify on every SHA bump.

If the determinism test fails after a section-11 SHA bump or a
pyodide upgrade, the divergence source must be pinned in this list
before the bump can land.

## Pyodide vs CPython parity

Pyodide ships CPython compiled to WebAssembly. Behavior is ~99% identical
to a host CPython of the same version for stdlib `math`, `statistics`,
and the operators sync.py uses — but `math.fsum`, `statistics.median_grouped`,
and float-repr corner cases have historically diverged in narrow cases.
T09 confirms parity by running section-11's `_calculate_derived_metrics`
twice: once via the pyodide harness (`pnpm snapshot:section-11`), once
via host CPython 3.12 (`tools/snapshot-section-11-native.py`), then
diffing every metric.

**Verdict (2026-05-21):** all 52 metrics produced by `pnpm snapshot:section-11`
on the `realistic-athlete` fixture against `section_11_sha = 224c369d`
are bit-identical between:

- pyodide `0.29.4` (CPython 3.12, WASM)
- host CPython `3.12.13` (managed by `uv`)

Reproduce the check:

```bash
# Install uv and Python 3.12 (one-time setup)
curl -LsSf https://astral.sh/uv/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"
uv python install 3.12

# Generate native + pyodide snapshots, diff them
pnpm snapshot:section-11
uv run --python 3.12 tools/snapshot-section-11-native.py --out /tmp/native-snapshots.json
pnpm tsx tools/diff-pyodide-vs-cpython.ts /tmp/native-snapshots.json
# expect: [diff] OK — 52 metrics bit-identical...
```

If the diff surfaces a divergence in the future (new fixture, new
section-11 SHA, new pyodide version), re-pin parity before letting
the harness become the oracle for additional metrics — running TS
ports against a known-divergent pyodide output silently drifts the
gate from CPython's real-world behavior.

Spot-check only — runs by hand at setup, on every section-11 SHA
bump, and on every pyodide upgrade. Not part of `pnpm test` because
it requires `uv` + Python 3.12 on the host, which CI doesn't
currently provision.

## Frozen clock

The harness exports a `DEFAULT_FROZEN_NOW = "2026-05-10T12:00:00"` anchor
and the `HARNESS_FIXTURES` allowlist binds a `frozenNow` to each fixture.
Most fixtures use the default; `data-gap-mid-history` overrides to
`2026-05-20T12:00:00` so its resumed week lands inside the 7d acute
window. Per-snapshot wrappers record the exact anchor each metric was
captured against (`frozen_now` field); the manifest top-level reports
the default. If a fixture's date range shifts, move its allowlist entry
in lockstep.

## Adding a new athlete

The harness iterates over the `HARNESS_FIXTURES` allowlist in
`tools/snapshot-section-11.ts`. To add a fixture:

1. Hand-craft `packages/core/tests/fixtures/golden/<slug>.json` with the
   intervals.icu envelope shape.
2. Append an entry to `HARNESS_FIXTURES` — `slug`, `frozenNow`, and a
   `description` explaining the branches the fixture exercises and the
   reason for its anchor.
3. Re-run `pnpm snapshot:section-11`. The script creates one subdirectory
   per slug and rewrites `manifest.json`.

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
