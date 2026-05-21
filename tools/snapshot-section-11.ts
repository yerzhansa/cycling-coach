/**
 * Pyodide-driven oracle generator: runs the section-11 Python
 * coaching protocol against a golden fixture and snapshots every
 * per-metric output to JSON.
 *
 * Methodology: characterization + differential testing (NOT TDD).
 * The Python at upstream is the source of truth; we capture its
 * outputs here so future TS metric ports have something to assert
 * against. No parity assertions ship from this script — those
 * come later, per F8+.
 *
 * Offline-mode choice: Option A (stub `requests` + monkey-patch
 * `IntervalsSync._intervals_get`). See tools/snapshot-section-11.README.md
 * for rationale and trade-offs.
 *
 * GPL discipline: this script reads only the section-11 (MIT)
 * source tree. It does not touch GC.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadPyodide } from "pyodide";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const PYODIDE_INDEX = resolve(REPO_ROOT, "node_modules/pyodide");

const SECTION_11_REPO =
  process.env.SECTION_11_REPO ?? resolve(REPO_ROOT, "../section-11");
const SYNC_PY_PATH = join(SECTION_11_REPO, "examples/sync.py");

const FIXTURE_REL = "packages/core/tests/fixtures/golden/realistic-athlete.json";
const ATHLETE_SLUG = "realistic-athlete";
const SNAPSHOT_ROOT_REL = "packages/core/tests/fixtures/snapshots";

// Anchor "now" inside the fixture's data window so date-relative
// filters in sync.py return non-empty slices. The realistic-athlete
// fixture's last activity is 2026-05-09; pinning to 2026-05-10
// gives ACWR a populated 7d window and keeps the 28d window
// representative. Future fixtures may store this alongside the
// data; for now it's a script-level constant documented in the
// README.
const FROZEN_NOW = "2026-05-10T12:00:00";

interface Manifest {
  section_11_sha: string;
  section_11_protocol_version: string;
  capture_date_utc: string;
  fixtures: string[];
  metrics: string[];
  pyodide_version: string;
  frozen_now: string;
  offline_mode: "A_stub_requests_plus_monkey_patch";
}

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
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
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

# === fixture slicing ===
FIXTURE = json.loads(FIXTURE_JSON)
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

try:
    derived = sync._calculate_derived_metrics(
        activities_7d=_ACTIVITIES_7D,
        activities_28d=_ACTIVITIES_28D,
        wellness_7d=_WELLNESS_7D,
        wellness_extended=_WELLNESS_28D,
        current_ctl=_CURRENT_CTL,
        current_atl=_CURRENT_ATL,
        current_tsb=_CURRENT_TSB,
        past_events=[],
        activities_for_consistency=_ACTIVITIES_7D,
        power_model={},
        benchmark_indoor=_BENCH_NONE,
        benchmark_outdoor=_BENCH_NONE,
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

OUTPUT_JSON = json.dumps(derived, default=str, sort_keys=True)
`;

async function main(): Promise<void> {
  const fixturePath = resolve(REPO_ROOT, FIXTURE_REL);
  const snapshotDirRel = join(SNAPSHOT_ROOT_REL, ATHLETE_SLUG);
  const snapshotDir = resolve(REPO_ROOT, snapshotDirRel);
  const manifestPath = resolve(REPO_ROOT, SNAPSHOT_ROOT_REL, "manifest.json");

  if (!existsSync(SYNC_PY_PATH)) {
    throw new Error(
      `section-11 sync.py not found at ${SYNC_PY_PATH}. ` +
        `Set SECTION_11_REPO env var to the section-11 checkout root, ` +
        `or clone CrankAddict/section-11 to ../section-11.`,
    );
  }
  if (!existsSync(fixturePath)) {
    throw new Error(`Fixture not found: ${fixturePath}`);
  }

  const syncPySource = readFileSync(SYNC_PY_PATH, "utf8");
  const fixtureJson = readFileSync(fixturePath, "utf8");
  const sha = readSection11Sha();
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

  pyodide.globals.set("FROZEN_NOW", FROZEN_NOW);
  pyodide.globals.set("SYNC_PY_PATH", SYNC_PY_PATH);
  pyodide.globals.set("SYNC_PY_SOURCE", syncPySource);
  pyodide.globals.set("FIXTURE_JSON", fixtureJson);

  await pyodide.runPythonAsync(HARNESS_PROLOGUE);
  const outputJson = pyodide.globals.get("OUTPUT_JSON") as string;
  const derived = JSON.parse(outputJson) as Record<string, unknown>;

  if ("__error__" in derived) {
    const err = derived.__error__ as { type: string; message: string; traceback: string };
    throw new Error(
      `section-11 metric computation raised ${err.type}: ${err.message}\n${err.traceback}`,
    );
  }

  ensureDir(snapshotDir);

  const metrics: string[] = [];
  for (const [name, value] of Object.entries(derived)) {
    const filePath = join(snapshotDir, `${name}.json`);
    const wrapper = {
      metric: name,
      athlete: ATHLETE_SLUG,
      section_11_sha: sha,
      section_11_protocol_version: protocolVersion,
      frozen_now: FROZEN_NOW,
      value,
    };
    writeFileSync(filePath, `${JSON.stringify(wrapper, null, 2)}\n`);
    metrics.push(name);
  }
  metrics.sort();

  const manifest: Manifest = {
    section_11_sha: sha,
    section_11_protocol_version: protocolVersion,
    capture_date_utc: new Date().toISOString(),
    fixtures: [ATHLETE_SLUG],
    metrics,
    pyodide_version: pyodideVersion,
    frozen_now: FROZEN_NOW,
    offline_mode: "A_stub_requests_plus_monkey_patch",
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  // eslint-disable-next-line no-console
  console.log(
    `[snapshot] wrote ${metrics.length} per-metric files under ${snapshotDirRel}/ + manifest`,
  );
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
