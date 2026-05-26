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

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { loadPyodide } from "pyodide";

import { deepCompare, METRIC_REGISTRY, REPO_ROOT } from "./check-metric-parity";
import { decideVerdict } from "./fuzz-parity-verdict";

const SECTION_11_REPO = process.env.SECTION_11_REPO ?? resolve(REPO_ROOT, "../section-11");
const SYNC_PY_PATH = join(SECTION_11_REPO, "examples/sync.py");
const GOLDEN_DIR = resolve(REPO_ROOT, "packages/core/tests/fixtures/golden");
// Divergence + oracle-error captures are random, oversized dumps — NOT curated
// fixtures. They land in a gitignored sibling dir so a stray `git add -A` can't
// sweep them into the committed golden corpus the gate and snapshot harness trust.
const FAIL_DIR = resolve(REPO_ROOT, "packages/core/tests/fixtures/_fuzz-fail");

interface Args {
  n: number;
  seed: number;
  fixture: string;
  frozenNow: string;
}

// Reject typo'd numeric flags fast and loudly, before the expensive Pyodide
// boot. Without this, `--n=5k` (→ NaN) or `--n=-1` runs the loop zero times:
// the compared===0 guard still fails the run, but only after loading the oracle
// and with a generic message. This points straight at the bad flag.
function intArg(flag: string, raw: string, min: number): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    console.error(`[fuzz-parity] invalid ${flag}=${raw}: expected an integer >= ${min}`);
    process.exit(2);
  }
  return n;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { n: 5000, seed: 20260525, fixture: "realistic-athlete", frozenNow: "2026-05-10T12:00:00" };
  for (const a of argv) {
    const m = /^--([a-zA-Z]+)=(.+)$/.exec(a);
    if (!m) continue;
    const [, k, v] = m;
    if (k === "n") out.n = intArg("--n", v!, 1);
    else if (k === "seed") out.seed = intArg("--seed", v!, 0);
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

# Fixture contract validation — mirrors the snapshot harness so the fuzzer's
# differential is as strong as the gate's. sync.py reads fixture
# fields via dict.get(), which silently returns None on a missing key; a
# perturbation that introduced an untracked silent-None path (or a typo'd
# field) would be read the same way by both sides and report a false parity.
# _TrackedDict logs every .get() of an absent key; compute() checks the log
# (minus the allowlist) after each run and fails loud on anything unexpected.
import re as _re
_TRACKED_MISSING = []
# Allowlist ported from the snapshot harness, plus icu_zone_times: perturb
# deletes it on ~30% of activities. The golden fixtures always include it, so
# the snapshot allowlist omits it — but here it is a legitimate optionality.
_ALLOWED_OPTIONAL_PATHS = {
    "FIXTURE.activities[*].icu_hr_decoupling",
    "FIXTURE.activities[*].icu_hr_zone_times",
    "FIXTURE.activities[*].icu_hrr",
    "FIXTURE.activities[*].icu_variability_index",
    "FIXTURE.activities[*].icu_zone_times",
    "FIXTURE.wellness[*].atl",
    "FIXTURE.wellness[*].ctl",
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

def compute(fixture_json):
    try:
        # Reset the tracker each call — the loop reuses this module after one exec.
        _TRACKED_MISSING.clear()
        FIX = _TrackedDict(json.loads(fixture_json), "FIXTURE")
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
        unallowed = sorted({
            p for p in _TRACKED_MISSING
            if _normalize_path(p) not in _ALLOWED_OPTIONAL_PATHS
        })
        if unallowed:
            return json.dumps({"__contract_violation__": {"missing_keys": unallowed}})
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

// Lazily create FAIL_DIR so a clean run leaves no empty dir behind, then write
// the capture. Both the divergence and oracle-error paths funnel through here.
function writeCapture(filePath: string, fixture: unknown): void {
  mkdirSync(FAIL_DIR, { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(fixture, null, 2)}\n`);
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
  // Per-metric coverage: `?? null` (below) masks an absent oracle key as null,
  // so a metric the oracle never emits — or emits only null — would ride the
  // green headline without ever being compared against a real value. Track both
  // so the verdict can disclose anything we never actually exercised.
  const oraclePresent: Record<string, number> = Object.fromEntries(metrics.map((m) => [m, 0]));
  const oracleNonNull: Record<string, number> = Object.fromEntries(metrics.map((m) => [m, 0]));
  let oracleErrors = 0;
  let firstOracleError: string | null = null;
  let firstOracleErrorPath: string | null = null;
  let contractViolations = 0;
  let firstViolation: string | null = null;
  let firstViolationPath: string | null = null;
  let compared = 0;
  // One reproducing fixture per diverging metric. A single global capture would
  // discard every metric that isn't the first to diverge — defeating the
  // capture-and-defend purpose for all the rest.
  const failPaths: Record<string, string> = {};

  for (let i = 0; i < args.n; i++) {
    const fixture = perturb(base, rnd);
    py.globals.set("FIXJSON", JSON.stringify(fixture));
    const derived = JSON.parse(py.runPython("compute(FIXJSON)") as string) as Record<string, unknown>;
    if ("__error__" in derived) {
      oracleErrors++;
      if (!firstOracleError) {
        firstOracleError = String(derived.__error__);
        firstOracleErrorPath = join(FAIL_DIR, `_fuzz-oracle-error-seed${args.seed}-i${i}.json`);
        writeCapture(firstOracleErrorPath, fixture);
      }
      continue;
    }
    if ("__contract_violation__" in derived) {
      contractViolations++;
      if (!firstViolation) {
        const v = derived.__contract_violation__ as { missing_keys?: string[] };
        firstViolation = (v.missing_keys ?? []).join(", ");
        firstViolationPath = join(FAIL_DIR, `_fuzz-contract-violation-seed${args.seed}-i${i}.json`);
        writeCapture(firstViolationPath, fixture);
      }
      continue;
    }
    compared++;
    for (const m of metrics) {
      // The oracle emits absent metrics as missing keys; the registry emits
      // explicit null. Normalize both to null before the bit-identity check —
      // but first record whether the oracle genuinely exercised this metric
      // (emitted the key, with a non-null value) so the mask can't hide a
      // never-compared metric.
      if (m in derived) oraclePresent[m]!++;
      const expected = derived[m] ?? null;
      if (expected !== null) oracleNonNull[m]!++;

      let tsVal: unknown;
      try {
        tsVal = METRIC_REGISTRY[m]!.compute({ fixture, frozenNow: args.frozenNow });
      } catch (e) {
        tsVal = `__ts_threw__:${(e as Error).message}`;
      }
      const actual = tsVal === undefined ? null : tsVal;
      if (deepCompare(expected, actual).length > 0) {
        mismatch[m]!++;
        if (!(m in failPaths)) {
          const failPath = join(FAIL_DIR, `_fuzz-fail-${m}-seed${args.seed}-i${i}.json`);
          writeCapture(failPath, fixture);
          failPaths[m] = failPath;
        }
      }
    }
  }

  const total = Object.values(mismatch).reduce((s, x) => s + x, 0);
  console.log(`[fuzz-parity] oracle: Python ${pyVersion} (Pyodide) · seed ${args.seed} · fixtures ${compared}/${args.n} (oracle errors: ${oracleErrors}, contract violations: ${contractViolations})`);
  for (const m of metrics) {
    if (mismatch[m]! > 0) console.log(`[fuzz-parity]   MISMATCH ${m}: ${mismatch[m]}`);
  }

  // Coverage disclosure: a metric the oracle never emitted (likely a registry/
  // oracle name mismatch) or emitted only null was never compared against a real
  // value — `?? null` would otherwise let it pass silently. Surface both so a
  // green run can't overstate what it proved.
  const neverPresent = metrics.filter((m) => oraclePresent[m] === 0);
  const presentButAlwaysNull = metrics.filter(
    (m) => oraclePresent[m]! > 0 && oracleNonNull[m] === 0,
  );
  const neverExercised = neverPresent.length + presentButAlwaysNull.length;
  if (compared > 0 && neverExercised > 0) {
    console.log(`[fuzz-parity]   NOTE — ${neverExercised}/${metrics.length} metric(s) never exercised on a real value:`);
    for (const m of neverPresent) {
      console.log(`[fuzz-parity]     ${m}: oracle never emitted this key (registry/oracle name mismatch?)`);
    }
    for (const m of presentButAlwaysNull) {
      console.log(`[fuzz-parity]     ${m}: oracle emitted only null across all ${compared} fixtures`);
    }
  }

  // OK is reported ONLY on a run that proved bit-identity: a non-zero fixture
  // count, every one compared clean, zero oracle throws. Any `__error__` means
  // the differential silently skipped that input (the signature-drift-on-a-SHA-
  // bump failure that used to slip through as a green "OK across 0 fixtures").
  const verdict = decideVerdict({ compared, oracleErrors, contractViolations, mismatchTotal: total });
  switch (verdict.status) {
    case "oracle-error":
      console.error(`[fuzz-parity] FAIL — oracle threw on ${oracleErrors}/${args.n} input(s); the differential never ran on them, so this is NOT a pass.`);
      console.error(`[fuzz-parity]   first oracle error: ${firstOracleError}`);
      console.error(`[fuzz-parity]   erroring fixture written to:\n  ${firstOracleErrorPath}`);
      break;
    case "contract-violation":
      console.error(`[fuzz-parity] FAIL — oracle read a silently-missing fixture key on ${contractViolations}/${args.n} input(s); both sides reading the same None would report a false parity, so this is NOT a pass.`);
      console.error(`[fuzz-parity]   first missing key(s): ${firstViolation}`);
      console.error(`[fuzz-parity]   If it is a legitimate schema optionality, add the path to _ALLOWED_OPTIONAL_PATHS in the prologue; otherwise fix perturb so it stops generating it. Fixture written to:\n  ${firstViolationPath}`);
      break;
    case "mismatch": {
      const captured = Object.values(failPaths);
      console.error(`[fuzz-parity] FAIL — ${total} metric mismatch(es) across ${captured.length} metric(s). Reproducing fixture(s) written to:`);
      for (const p of captured) console.error(`  ${p}`);
      console.error(`[fuzz-parity] Freeze each as a golden fixture (add to HARNESS_FIXTURES in tools/snapshot-section-11.ts, then \`pnpm snapshot:section-11\`) so the gate defends it.`);
      break;
    }
    case "empty":
      console.error(`[fuzz-parity] FAIL — 0 fixtures compared (n=${args.n}); refusing to report OK on a run that proved nothing.`);
      break;
    case "ok": {
      const caveat = neverExercised > 0 ? ` (${neverExercised} never exercised — see NOTE above)` : "";
      console.log(`[fuzz-parity] OK — all ${metrics.length} metrics bit-identical across ${compared}/${args.n} fixtures${caveat}`);
      break;
    }
  }
  return verdict.code;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(2);
  },
);
