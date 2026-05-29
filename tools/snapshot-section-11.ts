/**
 * Pyodide-driven oracle generator: runs the section-11 Python
 * coaching protocol against a golden fixture and snapshots every
 * per-metric output to JSON.
 *
 * Methodology: characterization + differential testing (NOT TDD).
 * The Python at upstream is the source of truth; we capture its
 * outputs here so future TS metric ports have something to assert
 * against. No parity assertions ship from this script — those
 * are the gate's job.
 *
 * Offline-mode choice: Option A (stub `requests` + monkey-patch
 * `IntervalsSync._intervals_get`). See tools/snapshot-section-11.README.md
 * for rationale and trade-offs.
 */

import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadPyodide } from "pyodide";

import type { Manifest, Snapshot } from "./check-metric-parity";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const PYODIDE_INDEX = resolve(REPO_ROOT, "node_modules/pyodide");

const SECTION_11_REPO =
  process.env.SECTION_11_REPO ?? resolve(REPO_ROOT, "../section-11");
const SYNC_PY_PATH = join(SECTION_11_REPO, "examples/sync.py");

const GOLDEN_DIR_REL = "packages/core/tests/fixtures/golden";
const SNAPSHOT_ROOT_REL = "packages/core/tests/fixtures/snapshots";

// Default anchor used when SNAPSHOT_FIXTURE_PATH points at a fixture not
// in the allowlist (determinism/contract tests). The manifest's
// `frozen_now` field also takes this value as the default; per-fixture
// overrides ride through each per-snapshot wrapper's `frozen_now` field.
const DEFAULT_FROZEN_NOW = "2026-05-10T12:00:00";

// Allowlist of golden fixtures the snapshot harness processes. Adding a
// fixture is an explicit edit here — the golden dir also holds fixtures
// owned by other tests (F7 reference substrate's `post-break-resume`,
// `zero-activities`) that don't conform to sync.py's contract and must
// not be run through this harness. Each entry's `description` field
// carries the rationale for the slug + the anchor it chose.
interface HarnessFixtureConfig {
  slug: string;
  frozenNow: string;
  description: string;
}

const HARNESS_FIXTURES: HarnessFixtureConfig[] = [
  {
    slug: "realistic-athlete",
    frozenNow: DEFAULT_FROZEN_NOW,
    description:
      "Happy-path baseline — sanitized real athlete bundle. Exercises the populated branches of every metric. Anchor 2026-05-10 sits one day after the fixture's last activity.",
  },
  {
    slug: "new-athlete-empty",
    frozenNow: DEFAULT_FROZEN_NOW,
    description:
      "Zero activities, zero wellness, zero ftp_history. Forces every 'no data' branch — ACWR div-by-zero, monotony of empty week, recovery_index no-contributors. Anchor doesn't matter; reuses the default.",
  },
  {
    slug: "data-gap-mid-history",
    frozenNow: "2026-05-20T12:00:00",
    description:
      "21 activities split by a 28-day gap (14 days 2026-04-01..04-14, gap 04-15..05-12, 7 days resumed 05-13..05-19). Exercises EWMA decay through the gap, ACWR chronic window seeing zeros, monotony on the resumed week. Anchor 2026-05-20 catches the resumed week in the 7d acute window.",
  },
  {
    slug: "boundary-monotony",
    frozenNow: DEFAULT_FROZEN_NOW,
    description:
      "Boundary-seeking fixture (fuzz-derived). Daily loads [21.2,154.3,268.1,122.0,34.6,33.1,231.2] over 05-04..05-10 put monotony's mean/stdev ratio exactly on the 2-dp boundary: the correctly-rounded statistics path gives 1.24, a naive float stdev gives 1.23. Defends the exact-rational mean/stdev port at the gate. Load-only (no wellness/ftp).",
  },
  {
    slug: "boundary-sum-strain",
    frozenNow: DEFAULT_FROZEN_NOW,
    description:
      "Boundary-seeking fixture (fuzz-derived). Daily loads 9.7/266.4/239.5/9.4 over 05-06..05-09 sum to exactly 525.0 under compensated (Neumaier) summation but 524.999…9 naively; with monotony 0.62 the product 325.5 rounds to strain 326 where a naive sum gives 325. Defends the compensated-sum port at the gate. Load-only (no wellness/ftp).",
  },
  {
    slug: "boundary-zone-total-secs",
    frozenNow: DEFAULT_FROZEN_NOW,
    description:
      "Boundary-seeking fixture (fuzz-derived). Three activities (05-08..05-10) whose z1–z7 one-decimal-second bins sum, per-activity-compensated, to exactly 36594s, but accumulate to 36594.00000000001s under a single flat naive sum across every activity's bins; that 1-ULP drift pushes total_hours across the 10.165 boundary (compensated 10.16 vs naive 10.17). Defends the per-activity compensated zone-total summation in the zone-distribution port. Zone-only (empty wellness/ftp).",
  },
  {
    slug: "multisport-tie",
    frozenNow: DEFAULT_FROZEN_NOW,
    description:
      "Primary-sport tiebreak fixture. Cycling [100,80,60] on 05-04..06 and run [60,60,60,60] on 05-07..10 each total exactly 240 over the 7d window; cycling is encountered first, so the `total > maxTotal` strict tiebreak (mirroring Python `max(dict, key=dict.get)` insertion order) must pick cycling. The two sports' daily distributions differ, so a tiebreak regression flips primary_sport_monotony to run's value — caught at the gate. Load+zones only (empty wellness/ftp).",
  },
  {
    slug: "multisport-thin-primary",
    frozenNow: DEFAULT_FROZEN_NOW,
    description:
      "effective_monotony selector branch B (multi-sport, primary=null → fall back to total). Cycling [80,80,80] on 05-04..06 (total 240, 3 days) and run [150,150] on 05-09..10 (total 300, 2 days): run wins primary on total but has <3 active days, so primary_sport_monotony is null while total monotony is non-null. The selector's `!== null` gate does load-bearing work here — inverting it regresses with no other fixture defense. Load+zones only (empty wellness/ftp).",
  },
  {
    slug: "populated-benchmark-and-consistency",
    frozenNow: DEFAULT_FROZEN_NOW,
    description:
      "Populated-branch coverage for consistency_index + benchmark_indoor + benchmark_outdoor — the F11 metrics whose previous fixtures all collapsed to the null branch. 4 WORKOUT events on 05-05/07/09/10 paired with cycling activities on 05-05/07/09 give matched=3, planned=4, consistency_index=0.75. FTP history has a 2026-03-15 entry sitting exactly at (frozenNow - 56d), exercising the +/-7d nearest-match window: indoor 280/270-1=0.037 in seasonal range [0.01,0.04] → seasonal_expected=true; outdoor 270/260-1=0.038 same range true. Without this fixture the parity gate is theatre for those three metrics.",
  },
  {
    slug: "rest-week-with-baseline",
    frozenNow: DEFAULT_FROZEN_NOW,
    description:
      "Constant-Load coverage for the monotony stdev=0 branch. 7 recovery rides on 05-04..05-10 at an IDENTICAL daily Load of 35.0 give the 7d series [35,35,35,35,35,35,35] — non-zero mean, sample stdev exactly 0 — so monotony hits the `stdevLoad <= 0 -> null` guard (a path the all-zero fixtures reach via a different branch). That null cascades: strain -> null, stress_tolerance -> null. Single-sport, so primary_sport_monotony hits its own stdev=0 null too. The 28-day wellness baseline (stable RHR 58 / HRV 52) populates recovery_index + HRV/RHR baselines through the flat block. Anchor 2026-05-10 puts the constant week in the 7d acute window.",
  },
];

function readPyodideVersion(): string {
  const pkg = JSON.parse(
    readFileSync(join(PYODIDE_INDEX, "package.json"), "utf8"),
  ) as { version: string };
  return pkg.version;
}

function readSection11Sha(): string {
  return execSync("git rev-parse HEAD", {
    cwd: SECTION_11_REPO,
    encoding: "utf8",
  }).trim();
}

function readSection11CommitDate(sha: string): string {
  // ISO 8601 UTC, derived from section-11's commit object — deterministic
  // for a given SHA, replaces the old wall-clock `capture_date_utc` which
  // broke `pnpm snapshot:section-11` byte-identity across consecutive runs.
  return execSync(`git show -s --format=%cI ${sha}`, {
    cwd: SECTION_11_REPO,
    encoding: "utf8",
  }).trim();
}

function readSyncPyVersion(syncPySource: string): string {
  // sync.py's docstring starts "Version 3.112 - ..." on the first
  // version line. Parse the first match.
  const match = syncPySource.match(/Version\s+(\d+\.\d+)/);
  if (!match) {
    throw new Error("Could not parse sync.py protocol version from header");
  }
  return match[1]!;
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

interface FixtureEntry {
  slug: string;
  path: string;
  frozenNow: string;
}

function resolveAllowlistedFixtures(goldenDir: string): FixtureEntry[] {
  return HARNESS_FIXTURES.map(({ slug, frozenNow }) => {
    const path = join(goldenDir, `${slug}.json`);
    if (!existsSync(path)) {
      throw new Error(
        `Allowlisted harness fixture not found: ${path}. ` +
          `Either create it or remove the entry from HARNESS_FIXTURES in tools/snapshot-section-11.ts.`,
      );
    }
    return { slug, path, frozenNow };
  });
}

const HARNESS_PROLOGUE = `
import sys, json, types
from datetime import datetime, timedelta

# === requests stub ===
# sync.py does \`import requests\` at module top, then routes
# every HTTP call through IntervalsSync._intervals_get. We replace
# requests with a stub module BEFORE sync.py is exec'd so the
# import resolves; the metric path doesn't actually call it.
class _StubResponse:
    def __init__(self, payload=None, status=200):
        self._payload = payload if payload is not None else {}
        self.status_code = status
    def json(self):
        return self._payload
    def raise_for_status(self):
        if self.status_code >= 400:
            raise Exception(f"HTTP {self.status_code} (stub)")

class _StubExceptions:
    Timeout = Exception
    RequestException = Exception
    ConnectionError = Exception
    HTTPError = Exception

_requests_stub = types.ModuleType("requests")
def _stub_call(*_a, **_k):
    return _StubResponse({})
_requests_stub.get = _stub_call
_requests_stub.post = _stub_call
_requests_stub.put = _stub_call
_requests_stub.delete = _stub_call
_requests_stub.head = _stub_call
_requests_stub.exceptions = _StubExceptions
sys.modules["requests"] = _requests_stub

# === datetime freeze ===
# sync.py calls datetime.now() in ~48 sites to derive rolling
# windows. Freeze the clock so the harness is deterministic and
# the fixture's activity dates fall inside the relevant windows.
_FROZEN_NOW = datetime.fromisoformat(FROZEN_NOW)

class _FrozenDateTime(datetime):
    @classmethod
    def now(cls, tz=None):
        if tz is None:
            return _FROZEN_NOW
        return _FROZEN_NOW.replace(tzinfo=tz)
    @classmethod
    def utcnow(cls):
        return _FROZEN_NOW
    @classmethod
    def today(cls):
        return _FROZEN_NOW

import datetime as _dt_module
_dt_module.datetime = _FrozenDateTime

# === load section-11 sync.py source ===
# exec rather than import so the harness controls the module
# namespace explicitly. sync.py's \`if __name__ == "__main__"\`
# guard prevents argparse / main() from running during exec.
_sync_ns = {"__name__": "section_11_sync_under_test", "__file__": SYNC_PY_PATH}
exec(SYNC_PY_SOURCE, _sync_ns)
IntervalsSync = _sync_ns["IntervalsSync"]

# === fixture contract validation ===
# sync.py reads fixture fields almost exclusively via dict.get(),
# which silently returns None on a missing key. A typo'd field
# ("activitiez") would produce a wrong-because-input-was-malformed
# snapshot, and we'd faithfully bit-port the wrong oracle. The
# TrackedDict wraps every dict that ultimately came from FIXTURE
# and logs every .get() of a key that was never present. After
# sync.py finishes computing, the harness checks _TRACKED_MISSING
# (minus the allowlist below) and fails loud if anything remains.
#
# Scope of tracking: only data that came from FIXTURE (the loaded
# JSON). The positional args we hand to _calculate_derived_metrics
# (power_model={}, race_calendar=None, etc.) are intentional empty
# placeholders and remain untracked — they're documented in the
# README's "Known gaps" section, not contract violations.
#
# Allowlist patterns use [*] as wildcard for any array index. The
# entries below are intervals.icu fields that may legitimately be
# absent on a per-record basis (older activities computed before
# the field existed, rest-day wellness entries with no Fitness/Fatigue
# scores, etc.) — they are part of the intervals.icu schema's optionality,
# not contract violations. Extending the list requires a README
# update in the "Contract validation" section.
import re as _re
_TRACKED_MISSING = []

_ALLOWED_OPTIONAL_PATHS = {
    "FIXTURE.activities[*].icu_hr_decoupling",
    "FIXTURE.activities[*].icu_hr_zone_times",
    "FIXTURE.activities[*].icu_hrr",
    "FIXTURE.activities[*].icu_variability_index",
    "FIXTURE.wellness[*].atl",
    "FIXTURE.wellness[*].ctl",
    # F11 fixture extensions — absent on every fixture that doesn't exercise
    # the populated benchmark / consistency branches; present on fixtures that
    # do. The harness reads them pass-through (no hardcoded overrides) per
    # ADR-0017's boundary contract.
    "FIXTURE.past_events",
    "FIXTURE.current_ftp_indoor",
    "FIXTURE.current_ftp_outdoor",
    "FIXTURE.ftp_history_indoor",
    "FIXTURE.ftp_history_outdoor",
    "FIXTURE.intervals",
}

def _normalize_path(path):
    return _re.sub(r"\\[\\d+\\]", "[*]", path)

class _TrackedDict(dict):
    def __init__(self, data, path):
        super().__init__()
        self._path = path
        for k, v in data.items():
            super().__setitem__(k, _wrap_tracked(v, f"{path}.{k}"))
    def get(self, key, default=None):
        if dict.__contains__(self, key):
            return dict.__getitem__(self, key)
        _TRACKED_MISSING.append(f"{self._path}.{key}")
        return default

def _wrap_tracked(value, path):
    if isinstance(value, dict):
        return _TrackedDict(value, path)
    if isinstance(value, list):
        return [_wrap_tracked(item, f"{path}[{i}]") for i, item in enumerate(value)]
    return value

# === fixture slicing ===
FIXTURE = _TrackedDict(json.loads(FIXTURE_JSON), "FIXTURE")
_activities_all = FIXTURE.get("activities", [])
_wellness_all = FIXTURE.get("wellness", [])

def _within(items, key, oldest, newest):
    out = []
    for it in items:
        if not isinstance(it, dict):
            continue
        d = it.get(key, "")
        if not isinstance(d, str):
            continue
        d10 = d[:10]
        if oldest <= d10 <= newest:
            out.append(it)
    return out

_TODAY = _FROZEN_NOW.strftime("%Y-%m-%d")
_OLDEST_7 = (_FROZEN_NOW - timedelta(days=6)).strftime("%Y-%m-%d")
_OLDEST_28 = (_FROZEN_NOW - timedelta(days=27)).strftime("%Y-%m-%d")

_ACTIVITIES_7D = _within(_activities_all, "start_date_local", _OLDEST_7, _TODAY)
_ACTIVITIES_28D = _within(_activities_all, "start_date_local", _OLDEST_28, _TODAY)
_WELLNESS_7D = _within(_wellness_all, "id", _OLDEST_7, _TODAY)
_WELLNESS_28D = _within(_wellness_all, "id", _OLDEST_28, _TODAY)

def _pick_latest_wellness(rows):
    if not rows:
        return {}
    return sorted(rows, key=lambda r: r.get("id", ""), reverse=True)[0]

_LATEST_WELLNESS = _pick_latest_wellness(_WELLNESS_28D) or {}
_CURRENT_CTL = _LATEST_WELLNESS.get("ctl") or 0.0
_CURRENT_ATL = _LATEST_WELLNESS.get("atl") or 0.0
_CURRENT_TSB = (_CURRENT_CTL - _CURRENT_ATL) if (_CURRENT_CTL is not None and _CURRENT_ATL is not None) else 0.0

# === instantiate IntervalsSync ===
# __init__ does NOT make network calls — it only sets attributes
# and computes auth header. Safe to call with stub credentials.
sync = IntervalsSync(
    athlete_id="stub-athlete",
    intervals_api_key="stub-key",
    github_token=None,
    debug=False,
)
# Empty intervals data — set by _generate_intervals() in the live
# pipeline. The direct-call path skips that, so prime it manually.
sync._intervals_data = {}

# Benchmark expects (benchmark_index, ftp_8_weeks_ago, current_ftp).
# (None, None, None) is the documented "insufficient FTP history" path.
_BENCH_NONE = (None, None, None)

# Pass-through read of F11 fixture extensions. The harness used to
# hardcode past_events=[] and benchmark_*=_BENCH_NONE, which made the
# parity gate vacuous for those metrics (every snapshot collapsed to
# the null branch). ADR-0017 makes the fixture the boundary — these
# fields are optional on every committed fixture and the harness
# computes the benchmark tuples by handing the fixture-provided FTP
# data to sync.py's own _calculate_benchmark_index. Absent fields
# produce the same null branches the hardcoded path did, so existing
# snapshots stay bit-identical; populated branches now actually run.
_past_events = FIXTURE.get("past_events", []) or []
_current_ftp_indoor = FIXTURE.get("current_ftp_indoor")
_ftp_history_indoor = FIXTURE.get("ftp_history_indoor") or {}
_current_ftp_outdoor = FIXTURE.get("current_ftp_outdoor")
_ftp_history_outdoor = FIXTURE.get("ftp_history_outdoor") or {}

if _current_ftp_indoor and _ftp_history_indoor:
    _idx_in, _ftp8_in = sync._calculate_benchmark_index(
        _current_ftp_indoor, _ftp_history_indoor
    )
    _benchmark_indoor = (_idx_in, _ftp8_in, _current_ftp_indoor)
else:
    _benchmark_indoor = _BENCH_NONE

if _current_ftp_outdoor and _ftp_history_outdoor:
    _idx_out, _ftp8_out = sync._calculate_benchmark_index(
        _current_ftp_outdoor, _ftp_history_outdoor
    )
    _benchmark_outdoor = (_idx_out, _ftp8_out, _current_ftp_outdoor)
else:
    _benchmark_outdoor = _BENCH_NONE

try:
    derived = sync._calculate_derived_metrics(
        activities_7d=_ACTIVITIES_7D,
        activities_28d=_ACTIVITIES_28D,
        wellness_7d=_WELLNESS_7D,
        wellness_extended=_WELLNESS_28D,
        current_ctl=_CURRENT_CTL,
        current_atl=_CURRENT_ATL,
        current_tsb=_CURRENT_TSB,
        past_events=_past_events,
        activities_for_consistency=_ACTIVITIES_7D,
        power_model={},
        benchmark_indoor=_benchmark_indoor,
        benchmark_outdoor=_benchmark_outdoor,
        vo2max=None,
        formatted_planned_workouts=[],
        race_calendar=None,
        power_curve_data=None,
        power_curve_dates=None,
        hr_curve_data=None,
        sustainability_curves={},
        sustainability_window=None,
        sport_settings={},
        icu_weight=_LATEST_WELLNESS.get("weight"),
    )
except Exception as e:
    import traceback
    derived = {
        "__error__": {
            "type": type(e).__name__,
            "message": str(e),
            "traceback": traceback.format_exc(),
        }
    }

if "__error__" not in derived:
    # === has_intervals per-activity classifier (v3.106) ===
    # Hoisted from sync.py:7866-7873 inside _format_activities. The upstream
    # emits has_intervals per activity in the formatted activity dict; we
    # surface it as a top-level derived key so the parity gate can assert
    # it without ingesting the full per-activity display block (which mixes
    # protocol output with formatting orthogonal to the predicate).
    #
    # Bypass _TrackedDict on the intervals lookup by reparsing FIXTURE_JSON:
    # (a) the upstream's intervals_by_id is built from self._intervals_data
    #     (a separate API surface), so the contract tracker has nothing to
    #     assert on it; (b) branch (e) of the predicate — entry present
    #     without an 'intervals' key — would otherwise raise a spurious
    #     missing-key event on _entry.get('intervals').
    _raw_fixture = json.loads(FIXTURE_JSON)
    _intervals_raw = _raw_fixture.get("intervals") or {}
    _has_intervals = {}
    for _act in _activities_all:
        if not isinstance(_act, dict):
            continue
        _act_id = str(_act.get("id"))
        _entry = _intervals_raw.get(_act_id)
        _flag = False
        if _entry:
            for _seg in (_entry.get("intervals") or []):
                if isinstance(_seg, dict) and _seg.get("type") == "WORK":
                    _flag = True
                    break
        _has_intervals[_act_id] = _flag
    # Explicit sort defends per-activity-map key order across Pyodide /
    # CPython / Node. json.dumps(sort_keys=True) below already sorts
    # globally; the explicit pre-sort keeps the convention legible at
    # the point the map is constructed.
    derived["has_intervals"] = {
        k: _has_intervals[k] for k in sorted(_has_intervals.keys())
    }

    # === effort_response_signal per-activity classifier (v3.105 / v11.34) ===
    # Hoisted from sync.py:3493-3534 (_classify_effort_response) +
    # sync.py:7858-7860 per-activity emission inside _format_activities.
    # As with has_intervals, reparse FIXTURE_JSON for the per-activity loop so
    # the icu_intensity / icu_rpe .get() calls don't log spurious missing-key
    # events on fixtures that don't carry those fields (the classifier itself
    # returns None for absent inputs, matching upstream behaviour).
    _effort_response = {}
    for _act in _raw_fixture.get("activities", []):
        if not isinstance(_act, dict):
            continue
        _act_id = str(_act.get("id"))
        _effort_response[_act_id] = sync._classify_effort_response(
            _act.get("icu_intensity"), _act.get("icu_rpe")
        )
    derived["effort_response_signal"] = {
        k: _effort_response[k] for k in sorted(_effort_response.keys())
    }

    # === weight_signal (v3.112) ===
    # Hoisted from sync.py:2746-2752 outside _calculate_derived_metrics.
    # The upstream assigns the result to data["current_status"]["weight"];
    # we surface it as a top-level derived key for the parity gate.
    #
    # _load_ftp_history is monkey-patched to read from the fixture's
    # ftp_history_indoor / ftp_history_outdoor records instead of disk —
    # the production helper reads ftp_history.json from cwd, which is
    # neither portable nor reproducible in the harness. _raw_fixture
    # bypasses _TrackedDict so empty / absent history dicts don't log
    # spurious missing-key events on the dict.get accesses inside
    # _build_weight_signal.
    _raw_ftp_indoor = _raw_fixture.get("ftp_history_indoor") or {}
    _raw_ftp_outdoor = _raw_fixture.get("ftp_history_outdoor") or {}
    sync._load_ftp_history = lambda: {
        "indoor": _raw_ftp_indoor,
        "outdoor": _raw_ftp_outdoor,
    }
    _raw_current_ftp_outdoor = _raw_fixture.get("current_ftp_outdoor")
    _raw_eftp = _raw_fixture.get("eftp")
    _weight_sport_settings = {
        "cycling": {"ftp": _raw_current_ftp_outdoor},
    } if _raw_current_ftp_outdoor else {}
    _weight_power_model = {"eftp": _raw_eftp} if _raw_eftp else {}
    _raw_wellness = _raw_fixture.get("wellness") or []
    _weight_signal_value = sync._build_weight_signal(
        _raw_wellness,
        _weight_sport_settings,
        _weight_power_model,
        None,
    )
    # Display sub-dict is out of scope per Wave 6 deferral — strip before
    # snapshotting so the parity gate doesn't pin a contract we don't ship.
    if _weight_signal_value and "display" in _weight_signal_value:
        del _weight_signal_value["display"]
    derived["weight_signal"] = _weight_signal_value

    _unallowed = sorted({
        p for p in _TRACKED_MISSING
        if _normalize_path(p) not in _ALLOWED_OPTIONAL_PATHS
    })
    if _unallowed:
        derived = {
            "__contract_violation__": {
                "missing_keys": _unallowed,
                "total_accesses": len(_TRACKED_MISSING),
                "message": (
                    "sync.py read None silently from fixture paths that don't exist. "
                    "Either fix the fixture to include the keys, or — if a key is "
                    "intentionally optional in the schema — extend the contract "
                    "allowlist in tools/snapshot-section-11.ts. See the README's "
                    "'Contract validation' section."
                ),
            }
        }

    # Explode the capability dict into capability.<sub> sibling keys so the
    # parity gate can assert each sub-key as its own one-metric-one-file
    # oracle. Lockstep with tools/snapshot-section-11-native.py.
    if isinstance(derived.get("capability"), dict):
        for _sub, _val in list(derived["capability"].items()):
            derived[f"capability.{_sub}"] = _val

OUTPUT_JSON = json.dumps(derived, default=str, sort_keys=True)
`;

async function processFixture(
  pyodide: Awaited<ReturnType<typeof loadPyodide>>,
  fixture: FixtureEntry,
  snapshotRoot: string,
  sha: string,
  protocolVersion: string,
): Promise<{ metrics: string[]; frozenNow: string }> {
  const fixtureJson = readFileSync(fixture.path, "utf8");

  pyodide.globals.set("FROZEN_NOW", fixture.frozenNow);
  pyodide.globals.set("FIXTURE_JSON", fixtureJson);

  await pyodide.runPythonAsync(HARNESS_PROLOGUE);
  const outputJson = pyodide.globals.get("OUTPUT_JSON") as string;
  const derived = JSON.parse(outputJson) as Record<string, unknown>;

  if ("__error__" in derived) {
    const err = derived.__error__ as {
      type: string;
      message: string;
      traceback: string;
    };
    throw new Error(
      `section-11 metric computation raised ${err.type} for fixture '${fixture.slug}': ${err.message}\n${err.traceback}`,
    );
  }

  if ("__contract_violation__" in derived) {
    const violation = derived.__contract_violation__ as {
      missing_keys: string[];
      total_accesses: number;
      message: string;
    };
    const lines = violation.missing_keys.map((k) => `  - ${k}`).join("\n");
    throw new Error(
      `fixture/sync.py contract violation for '${fixture.slug}': ${violation.missing_keys.length} ` +
        `unique missing key(s) read silently as None ` +
        `(${violation.total_accesses} total .get() accesses):\n${lines}\n\n` +
        violation.message,
    );
  }

  const snapshotDir = join(snapshotRoot, fixture.slug);
  ensureDir(snapshotDir);

  const metrics: string[] = [];
  for (const [name, value] of Object.entries(derived)) {
    const filePath = join(snapshotDir, `${name}.json`);
    const wrapper = {
      metric: name,
      athlete: fixture.slug,
      section_11_sha: sha,
      section_11_protocol_version: protocolVersion,
      frozen_now: fixture.frozenNow,
      value,
    } satisfies Snapshot;
    writeFileSync(filePath, `${JSON.stringify(wrapper, null, 2)}\n`);
    metrics.push(name);
  }
  metrics.sort();
  return { metrics, frozenNow: fixture.frozenNow };
}

async function main(): Promise<void> {
  // `SNAPSHOT_FIXTURE_PATH` overrides the input — used by the
  // contract-validation/determinism tests to point at a single
  // deliberately corrupted or temp fixture without touching the
  // committed golden set. When unset, every `.json` under
  // `packages/core/tests/fixtures/golden/` is processed.
  // `SNAPSHOT_OUT_DIR` overrides the snapshot output root — used by the
  // determinism test to write to temp dirs instead of clobbering the
  // committed snapshots. Defaults to the canonical SNAPSHOT_ROOT_REL.
  const snapshotRoot = process.env.SNAPSHOT_OUT_DIR
    ? resolve(process.env.SNAPSHOT_OUT_DIR)
    : resolve(REPO_ROOT, SNAPSHOT_ROOT_REL);
  const goldenDir = resolve(REPO_ROOT, GOLDEN_DIR_REL);
  const manifestPath = join(snapshotRoot, "manifest.json");

  let fixtures: FixtureEntry[];
  if (process.env.SNAPSHOT_FIXTURE_PATH) {
    const path = resolve(process.env.SNAPSHOT_FIXTURE_PATH);
    if (!existsSync(path)) {
      throw new Error(`Fixture not found: ${path}`);
    }
    fixtures = [
      {
        slug: basename(path).replace(/\.json$/, ""),
        path,
        frozenNow: DEFAULT_FROZEN_NOW,
      },
    ];
  } else {
    if (!existsSync(goldenDir)) {
      throw new Error(`Golden fixtures dir not found: ${goldenDir}`);
    }
    fixtures = resolveAllowlistedFixtures(goldenDir);
  }

  if (!existsSync(SYNC_PY_PATH)) {
    throw new Error(
      `section-11 sync.py not found at ${SYNC_PY_PATH}. ` +
        `Set SECTION_11_REPO env var to the section-11 checkout root, ` +
        `or clone CrankAddict/section-11 to ../section-11.`,
    );
  }

  const syncPySource = readFileSync(SYNC_PY_PATH, "utf8");
  const sha = readSection11Sha();
  const commitDate = readSection11CommitDate(sha);
  const protocolVersion = readSyncPyVersion(syncPySource);
  const pyodideVersion = readPyodideVersion();

  // eslint-disable-next-line no-console
  console.log(
    `[snapshot] section-11 sha=${sha.slice(0, 12)} protocol=${protocolVersion} pyodide=${pyodideVersion}`,
  );

  const pyodide = await loadPyodide({
    indexURL: PYODIDE_INDEX,
    stdout: () => {
      // Suppress sync.py print() noise.
    },
  });

  pyodide.globals.set("SYNC_PY_PATH", SYNC_PY_PATH);
  pyodide.globals.set("SYNC_PY_SOURCE", syncPySource);

  const results: { slug: string; metrics: string[] }[] = [];
  for (const fixture of fixtures) {
    const { metrics } = await processFixture(
      pyodide,
      fixture,
      snapshotRoot,
      sha,
      protocolVersion,
    );
    results.push({ slug: fixture.slug, metrics });
  }

  const fixtureSlugs = results.map((r) => r.slug).sort();
  const allMetrics = [...new Set(results.flatMap((r) => r.metrics))].sort();

  const manifest: Manifest = {
    section_11_sha: sha,
    section_11_protocol_version: protocolVersion,
    section_11_commit_date: commitDate,
    fixtures: fixtureSlugs,
    metrics: allMetrics,
    pyodide_version: pyodideVersion,
    frozen_now: DEFAULT_FROZEN_NOW,
    offline_mode: "A_stub_requests_plus_monkey_patch",
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  for (const { slug, metrics } of results) {
    // eslint-disable-next-line no-console
    console.log(
      `[snapshot] wrote ${metrics.length} per-metric files under ${join(SNAPSHOT_ROOT_REL, slug)}/`,
    );
  }
  // eslint-disable-next-line no-console
  console.log(
    `[snapshot] manifest pins ${fixtureSlugs.length} fixture(s) + ${allMetrics.length} metric(s)`,
  );
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
