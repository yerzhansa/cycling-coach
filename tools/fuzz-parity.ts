/**
 * Differential fuzz-parity harness.
 *
 * The parity gate (`check-metric-parity`) asserts the TS Reference metrics
 * are bit-identical to the upstream Python protocol — but only on a handful
 * of hand-authored golden fixtures whose tidy numbers never land on a
 * rounding boundary. That blind spot let a string of float-precision
 * deviations ship green (base-10 rounding, float mean/stdev, naive `sum()`),
 * each invisible until an input lands within a ULP of a `round()` boundary.
 *
 * This tool closes the blind spot the durable way: it generates many
 * randomized fixtures (seeded → reproducible), runs each through BOTH the
 * Python oracle (sync.py under Pyodide) and the TS `METRIC_REGISTRY`, and
 * asserts bit-identity across every metric. Inputs are biased toward the
 * boundary-hitting regime (one-decimal loads / HRV / RHR — integers never
 * expose the drift). A divergence is written to disk so it can be frozen as
 * a golden fixture (see `tools/snapshot-section-11.ts` allowlist).
 *
 * It is a dev-time / manual tool, NOT part of `pnpm test`: it needs Pyodide
 * and the upstream checkout, which CI doesn't provision (same constraint as
 * `diff-pyodide-vs-cpython.ts`). Run by hand during porting, on an upstream
 * SHA bump, or before a wave that adds float-heavy metrics.
 *
 * IMPORTANT — the oracle's Python version is load-bearing. Pyodide currently
 * bundles CPython 3.13, whose `sum()` (Neumaier compensated, 3.12+) and
 * `statistics.stdev` (correctly-rounded sqrt, 3.12+) differ from 3.10/3.11.
 * The TS helpers in `metrics/statistics.ts` reproduce the 3.12+ semantics;
 * if Pyodide's bundled Python changes, re-confirm them here.
 *
 *   Usage: pnpm fuzz-parity [--n=5000] [--seed=20260525] [--fixture=realistic-athlete]
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { loadPyodide } from "pyodide";

import { deepCompare, METRIC_REGISTRY, REPO_ROOT } from "./check-metric-parity";

const SECTION_11_REPO = process.env.SECTION_11_REPO ?? resolve(REPO_ROOT, "../section-11");
const SYNC_PY_PATH = join(SECTION_11_REPO, "examples/sync.py");
const GOLDEN_DIR = resolve(REPO_ROOT, "packages/core/tests/fixtures/golden");
const FAIL_DIR = resolve(REPO_ROOT, "packages/core/tests/fixtures/golden");

interface Args {
  n: number;
  seed: number;
  fixture: string;
  frozenNow: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { n: 5000, seed: 20260525, fixture: "realistic-athlete", frozenNow: "2026-05-10T12:00:00" };
  for (const a of argv) {
    const m = /^--([a-zA-Z]+)=(.+)$/.exec(a);
    if (!m) continue;
    const [, k, v] = m;
    if (k === "n") out.n = Number(v);
    else if (k === "seed") out.seed = Number(v);
    else if (k === "fixture") out.fixture = v!;
    else if (k === "frozen") out.frozenNow = v!;
  }
  return out;
}

// The Pyodide prologue: stub `requests`, freeze `datetime` to the anchor,
// exec the upstream source, then expose `compute(fixture_json)` returning the
// full derived-metrics dict. Mirrors the setup in `tools/snapshot-section-11.ts`
// (kept inline so the loop can call `compute` thousands of times after a
// single `exec`).
const ORACLE_PROLOGUE = `
import sys, json, types
from datetime import datetime, timedelta

class _StubResponse:
    def __init__(self, payload=None, status=200):
        self._payload = payload or {}; self.status_code = status
    def json(self): return self._payload
    def raise_for_status(self):
        if self.status_code >= 400: raise Exception("HTTP")
class _StubExceptions:
    Timeout=Exception; RequestException=Exception; ConnectionError=Exception; HTTPError=Exception
_rs = types.ModuleType("requests")
def _c(*a, **k): return _StubResponse({})
_rs.get=_rs.post=_rs.put=_rs.delete=_rs.head=_c
_rs.exceptions=_StubExceptions
sys.modules["requests"]=_rs

_FN = datetime.fromisoformat(FROZEN_NOW)
class _FrozenDateTime(datetime):
    @classmethod
    def now(cls, tz=None): return _FN if tz is None else _FN.replace(tzinfo=tz)
    @classmethod
    def utcnow(cls): return _FN
    @classmethod
    def today(cls): return _FN
import datetime as _dtm
_dtm.datetime = _FrozenDateTime

_ns = {"__name__": "upstream_under_test", "__file__": "sync.py"}
exec(SYNC_PY_SOURCE, _ns)
IntervalsSync = _ns["IntervalsSync"]

def compute(fixture_json):
    try:
        FIX = json.loads(fixture_json)
        acts = FIX.get("activities", []) or []
        well = FIX.get("wellness", []) or []
        def within(items, key, oldest, newest):
            out = []
            for it in items:
                if not isinstance(it, dict): continue
                d = it.get(key, "")
                if not isinstance(d, str): continue
                if oldest <= d[:10] <= newest: out.append(it)
            return out
        today = _FN.strftime("%Y-%m-%d")
        o7 = (_FN - timedelta(days=6)).strftime("%Y-%m-%d")
        o28 = (_FN - timedelta(days=27)).strftime("%Y-%m-%d")
        a7 = within(acts, "start_date_local", o7, today)
        a28 = within(acts, "start_date_local", o28, today)
        w7 = within(well, "id", o7, today)
        w28 = within(well, "id", o28, today)
        lw = (sorted(w28, key=lambda r: r.get("id",""), reverse=True)[0] if w28 else {}) or {}
        cctl = lw.get("ctl") or 0.0; catl = lw.get("atl") or 0.0
        ctsb = (cctl - catl) if (cctl is not None and catl is not None) else 0.0
        sync = IntervalsSync(athlete_id="s", intervals_api_key="k", github_token=None, debug=False)
        sync._intervals_data = {}
        BN = (None, None, None)
        derived = sync._calculate_derived_metrics(
            activities_7d=a7, activities_28d=a28, wellness_7d=w7, wellness_extended=w28,
            current_ctl=cctl, current_atl=catl, current_tsb=ctsb, past_events=[],
            activities_for_consistency=a7, power_model={}, benchmark_indoor=BN, benchmark_outdoor=BN,
            vo2max=None, formatted_planned_workouts=[], race_calendar=None, power_curve_data=None,
            power_curve_dates=None, hr_curve_data=None, sustainability_curves={}, sustainability_window=None,
            sport_settings={}, icu_weight=lw.get("weight"))
        return json.dumps(derived, default=str, sort_keys=True)
    except Exception as e:
        return json.dumps({"__error__": f"{type(e).__name__}: {e}"})
`;

// A small linear-congruential PRNG so runs are reproducible from --seed.
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

const SPORT_TYPES = ["Ride", "VirtualRide", "Run", "VirtualRun", "TrailRun", "NordicSki",
  "Swim", "Rowing", "WeightTraining", "Walk", "Hike", "Yoga", "Workout"];
const ZONE_IDS = ["Z1", "Z2", "Z3", "Z4", "Z5", "Z6", "Z7"];

// Perturb the base fixture's numeric inputs into the boundary-hitting regime:
// one-decimal loads/HRV/RHR (integers never expose the float drift), varied
// sport families, and a mix of power / HR zone arrays to exercise the basis
// and primary-sport logic.
function perturb(base: { activities: Record<string, unknown>[]; wellness: Record<string, unknown>[] }, rnd: () => number): unknown {
  const pick = <T>(a: T[]): T => a[Math.floor(rnd() * a.length)]!;
  const dec1 = (hi: number) => Math.round(rnd() * hi * 10) / 10;
  const f = structuredClone(base);
  for (const a of f.activities) {
    a.type = pick(SPORT_TYPES);
    a.icu_training_load = rnd() < 0.1 ? 0 : dec1(300);
    if (rnd() < 0.7) {
      a.icu_zone_times = ZONE_IDS.map((id) => ({ id, secs: dec1(3600) }));
    } else {
      delete a.icu_zone_times;
    }
    if (rnd() < 0.4) a.icu_hr_zone_times = Array.from({ length: 5 }, () => dec1(3000));
  }
  for (const w of f.wellness) {
    w.hrv = rnd() < 0.05 ? null : Math.round((10 + rnd() * 240) * 10) / 10;
    w.restingHR = rnd() < 0.05 ? 0 : Math.round((35 + rnd() * 60) * 10) / 10;
  }
  return f;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const base = JSON.parse(readFileSync(join(GOLDEN_DIR, `${args.fixture}.json`), "utf8"));
  const syncSource = readFileSync(SYNC_PY_PATH, "utf8");

  const py = await loadPyodide({ indexURL: resolve(REPO_ROOT, "node_modules/pyodide") });
  py.globals.set("FROZEN_NOW", args.frozenNow);
  py.globals.set("SYNC_PY_SOURCE", syncSource);
  py.runPython(ORACLE_PROLOGUE);
  const pyVersion = py.runPython("__import__('sys').version.split()[0]") as string;

  const rnd = makeRng(args.seed);
  const metrics = Object.keys(METRIC_REGISTRY);
  const mismatch: Record<string, number> = Object.fromEntries(metrics.map((m) => [m, 0]));
  let oracleErrors = 0;
  let compared = 0;
  let firstFailPath: string | null = null;

  for (let i = 0; i < args.n; i++) {
    const fixture = perturb(base, rnd);
    py.globals.set("FIXJSON", JSON.stringify(fixture));
    const derived = JSON.parse(py.runPython("compute(FIXJSON)") as string) as Record<string, unknown>;
    if ("__error__" in derived) {
      oracleErrors++;
      continue;
    }
    compared++;
    for (const m of metrics) {
      let tsVal: unknown;
      try {
        tsVal = METRIC_REGISTRY[m]!.compute({ fixture, frozenNow: args.frozenNow });
      } catch (e) {
        tsVal = `__ts_threw__:${(e as Error).message}`;
      }
      // The oracle emits absent metrics as missing keys; the registry emits
      // explicit null. Normalize both to null before the bit-identity check.
      const expected = derived[m] ?? null;
      const actual = tsVal === undefined ? null : tsVal;
      if (deepCompare(expected, actual).length > 0) {
        mismatch[m]!++;
        if (!firstFailPath) {
          firstFailPath = join(FAIL_DIR, `_fuzz-fail-${m}-seed${args.seed}-i${i}.json`);
          writeFileSync(firstFailPath, `${JSON.stringify(fixture, null, 2)}\n`);
        }
      }
    }
  }

  const total = Object.values(mismatch).reduce((s, x) => s + x, 0);
  console.log(`[fuzz-parity] oracle: Python ${pyVersion} (Pyodide) · seed ${args.seed} · fixtures ${compared}/${args.n} (oracle errors: ${oracleErrors})`);
  for (const m of metrics) {
    if (mismatch[m]! > 0) console.log(`[fuzz-parity]   MISMATCH ${m}: ${mismatch[m]}`);
  }
  if (total === 0) {
    console.log(`[fuzz-parity] OK — all ${metrics.length} metrics bit-identical across ${compared} fixtures`);
    return 0;
  }
  console.log(`[fuzz-parity] FAIL — ${total} metric mismatch(es). First failing fixture written to:\n  ${firstFailPath}`);
  console.log(`[fuzz-parity] Freeze it as a golden fixture (add to HARNESS_FIXTURES in tools/snapshot-section-11.ts, then \`pnpm snapshot:section-11\`) so the gate defends it.`);
  return 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(2);
  },
);
