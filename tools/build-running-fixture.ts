// Builds the `running-only` golden fixture: a FULLY SYNTHETIC bundle of Run /
// TrailRun activities carrying realistic, low-intensity-dominant HR-zone time
// data and non-zero per-session load. No real data, no sanitizer involvement —
// every byte is generated from the closed-form patterns here.
//
// Why this fixture exists: it is the pure-pace coverage substrate. The runs
// carry NO watts / power fields of any kind, so the parity gate's power-family
// snapshots collapse to their null blocks while the load-management survivors
// (ACWR / monotony / strain / stress_tolerance) and the zone-distribution
// survivors (Seiler TID, zone_distribution_7d, easy_time_ratio, grey-zone %,
// quality-intensity %) all compute NON-degenerately off HR zones. Runners are
// commonly HR-zoned, so every session uses `icu_hr_zone_times` (a flat
// seconds array indexed to z1..z7) — which also exercises the HR-fallback
// path (`zone_basis == "hr"`) that the cycling fixtures' power zones never
// reach.
//
// Determinism: no Math.random / Date.now. Every date is derived from the
// frozen anchor string via ymdMinus (UTC calendar math); the load + zone
// patterns are explicit constants. Re-running produces byte-identical output.
// The build ends with a non-vacuity guard that independently recomputes the
// central claims (acute + chronic load non-zero with a non-constant 7d series;
// a populated, low-intensity-dominant zone distribution) and fails unless they
// hold — so a "parity-green-but-vacuous" fixture (load present but zone times
// starved, or a constant load series that nulls monotony) can never ship.
//
// Usage (operator, dev-time):
//   pnpm exec tsx tools/build-running-fixture.ts [--frozen-now 1998-06-04T12:00:00] [--out <path>]

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseFixtureArgs,
  runFixtureCli,
  writeFixtureWithChecksum,
  ymdMinus,
} from "./fixture-builder-util.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUT = resolve(REPO_ROOT, "packages/core/tests/fixtures/golden/running-only.json");

// Synthetic-epoch anchor (one full Gregorian cycle back from the real era).
// This fixture is fully synthetic — no real PII — but the anchor sits in the
// synthetic epoch so any future regen lands its dates pre-cutoff, consistent
// with the fixture-privacy invariant (tools/check-fixture-privacy.ts).
const DEFAULT_FROZEN_NOW = "1998-06-04T12:00:00";

// Synthetic id base, reserved per-fixture so the synthetic fixtures never
// collide: 90101 = curve, 90201 = dfa, 90301 = running. Well above the
// real-data sentinel (12345) and below nothing real.
const SYNTHETIC_ID_BASE = 90301;

// Seiler-zone split applied to every run: ~80% easy (Z1+Z2), ~5% grey (Z3),
// ~15% hard (Z4). Co-present with the low-intensity-dominant framing the
// fixture targets (easy_time_ratio ~0.80, a "Polarized" TID classification).
// Fractions chosen so each run's seconds split to integers on the moving
// times below.
const Z1_FRAC = 0.5;
const Z2_FRAC = 0.3;
const Z3_FRAC = 0.05;
const Z4_FRAC = 0.15;

// Flat HR-zone seconds array [z1,z2,z3,z4,z5,z6,z7] for a run of `movingSecs`,
// split by the fixed low-intensity-dominant fractions. The trailing three hard
// zones stay 0 — a runner's hard time folds into Z4 here. Zero bins are
// skipped by both the oracle and the TS port (the `if secs` guard), so they
// neither alter the basis nor the totals.
function hrZoneTimes(movingSecs: number): number[] {
  return [
    Math.round(movingSecs * Z1_FRAC),
    Math.round(movingSecs * Z2_FRAC),
    Math.round(movingSecs * Z3_FRAC),
    Math.round(movingSecs * Z4_FRAC),
    0,
    0,
    0,
  ];
}

// One run's calendar offset (days before the anchor), type, load, and moving
// time. The acute window is now-6..now-0; the chronic window is now-27..now-0.
// The 7d block carries a NON-CONSTANT daily-load series with two rest days, so
// monotony's sample stdev is > 0 (a constant series nulls monotony) while at
// least three run days keep primary_sport_monotony populated. The TrailRun in
// the acute window exercises a second `run`-family activity type.
interface RunSpec {
  daysAgo: number;
  type: "Run" | "TrailRun";
  load: number;
  movingSecs: number;
}

const RUN_SPECS: RunSpec[] = [
  // ── chronic-only block (now-27 .. now-7): populates the 28d load + 28d TID ──
  { daysAgo: 27, type: "Run", load: 48, movingSecs: 3600 },
  { daysAgo: 25, type: "Run", load: 72, movingSecs: 4200 },
  { daysAgo: 23, type: "TrailRun", load: 90, movingSecs: 6000 },
  { daysAgo: 21, type: "Run", load: 35, movingSecs: 2400 },
  { daysAgo: 18, type: "Run", load: 55, movingSecs: 3600 },
  { daysAgo: 16, type: "Run", load: 80, movingSecs: 4800 },
  { daysAgo: 14, type: "Run", load: 42, movingSecs: 3000 },
  { daysAgo: 11, type: "Run", load: 60, movingSecs: 3600 },
  { daysAgo: 9, type: "Run", load: 50, movingSecs: 3000 },
  // ── acute block (now-6 .. now-0): the 7d series [45,0,70,38,85,0,52] ──
  { daysAgo: 6, type: "Run", load: 45, movingSecs: 3600 },
  // now-5 rest (no activity)
  { daysAgo: 4, type: "Run", load: 70, movingSecs: 4200 },
  { daysAgo: 3, type: "Run", load: 38, movingSecs: 2400 },
  { daysAgo: 2, type: "TrailRun", load: 85, movingSecs: 6000 },
  // now-1 rest (no activity)
  { daysAgo: 0, type: "Run", load: 52, movingSecs: 3600 },
];

interface BuiltFixture {
  activities: Record<string, unknown>[];
  wellness: Record<string, unknown>[];
  ftp_history: unknown[];
}

function buildFixture(frozenNow: string): BuiltFixture {
  const activities: Record<string, unknown>[] = [];
  const wellnessDates = new Set<string>();

  RUN_SPECS.forEach((spec, i) => {
    const id = SYNTHETIC_ID_BASE + i;
    const date = ymdMinus(frozenNow, spec.daysAgo);
    wellnessDates.add(date);
    activities.push({
      id,
      start_date_local: `${date}T07:00:00`,
      type: spec.type,
      name: spec.type === "TrailRun" ? "synthetic-trail-run" : "synthetic-run",
      moving_time: spec.movingSecs,
      elapsed_time: spec.movingSecs + 60,
      icu_training_load: spec.load,
      // Runners are commonly HR-zoned: flat seconds array indexed z1..z7. With
      // no power fields present this drives the HR-fallback path (zone_basis ==
      // "hr") in the distribution metrics.
      icu_hr_zone_times: hrZoneTimes(spec.movingSecs),
      // Present-but-null nullable fields the upstream reads per-activity via
      // dict.get(): keeping them present (not absent) keeps the harness's
      // contract tracker quiet without introducing power/HR-derived signal.
      // `decoupling` (NOT `icu_hr_decoupling`) is the present key: the upstream
      // reads `icu_hr_decoupling` first (allowlisted-optional, so its absence
      // is fine) then falls back to `decoupling`, which must be present so the
      // fallback read does not log a missing-key contract violation.
      icu_zone_times: null,
      decoupling: null,
      icu_efficiency_factor: null,
    });
  });

  // One wellness row per training day (stable RHR/HRV) so the recovery-index
  // window has rows to read; the central claims do not depend on these, but a
  // populated baseline keeps the recovery survivors non-degenerate too. No
  // sportInfo / athlete / curve keys — this fixture targets the load + zone
  // survivors only.
  const wellness = [...wellnessDates]
    .sort()
    .map((date) => ({
      id: date,
      weight: null,
      restingHR: 50,
      hrv: 70,
      sleepSecs: null,
      sleepQuality: null,
    }));

  return { activities, wellness, ftp_history: [] };
}

// ─── Non-vacuity guard ─────────────────────────────────────────────────────
// Recompute the central claims independently (plain TS arithmetic mirroring the
// documented thresholds) and fail the build if vacuous:
//   1. ACWR / strain inputs: chronic (28d) total load > 0 AND acute (7d) total
//      load > 0.
//   2. Monotony input: the 7d daily-load series is NON-CONSTANT (sample stdev
//      > 0) with >= 1 active day — else monotony (and the strain cascade) null.
//   3. Primary-sport monotony input: >= 3 active run days in the 7d window.
//   4. Seiler-TID input: the 7d window carries populated, low-intensity-
//      dominant zone time (total zone secs > 0, easy ratio in [0.70, 0.90]).
function assertNonVacuous(fixture: BuiltFixture, frozenNow: string): void {
  const fail = (msg: string): never => {
    throw new Error(`[build-running-fixture] non-vacuity guard failed: ${msg}`);
  };

  const acuteDates = new Set<string>();
  const chronicDates = new Set<string>();
  for (let d = 0; d < 7; d++) acuteDates.add(ymdMinus(frozenNow, d));
  for (let d = 0; d < 28; d++) chronicDates.add(ymdMinus(frozenNow, d));

  // Daily load buckets within each window.
  const acuteDaily = new Map<string, number>();
  let chronicTotal = 0;
  let acuteZoneTotal = 0;
  let acuteEasy = 0;
  let acuteRunActiveDays = 0;
  const acuteRunDates = new Set<string>();

  for (const act of fixture.activities) {
    const date = String(act.start_date_local).slice(0, 10);
    const load = Number(act.icu_training_load) || 0;
    const type = String(act.type);
    if (type !== "Run" && type !== "TrailRun") {
      fail(`non-run activity type "${type}" leaked into the running-only fixture`);
    }
    if (chronicDates.has(date)) chronicTotal += load;
    if (acuteDates.has(date)) {
      acuteDaily.set(date, (acuteDaily.get(date) ?? 0) + load);
      if (load > 0) acuteRunDates.add(date);
      const z = act.icu_hr_zone_times;
      if (Array.isArray(z)) {
        const secs = z.map((v) => (typeof v === "number" ? v : 0));
        const total = secs.reduce((a, b) => a + b, 0);
        acuteZoneTotal += total;
        // Seiler easy = Z1 + Z2 (first two bins).
        acuteEasy += (secs[0] ?? 0) + (secs[1] ?? 0);
      }
    }
  }
  acuteRunActiveDays = acuteRunDates.size;

  // 1. Acute + chronic load.
  if (chronicTotal <= 0) fail(`28d chronic total load is ${chronicTotal} (need > 0 for ACWR)`);
  const acuteSeries = [...acuteDates].sort().map((d) => acuteDaily.get(d) ?? 0);
  const acuteTotal = acuteSeries.reduce((a, b) => a + b, 0);
  if (acuteTotal <= 0) fail(`7d acute total load is ${acuteTotal} (need > 0 for strain)`);

  // 2. Non-constant 7d series (sample stdev > 0).
  const n = acuteSeries.length;
  const mean = acuteTotal / n;
  const variance = acuteSeries.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1);
  if (!(variance > 0)) {
    fail(`7d daily-load series is constant (stdev 0) → monotony would be null: [${acuteSeries}]`);
  }

  // 3. Primary-sport (run) active days.
  if (acuteRunActiveDays < 3) {
    fail(`only ${acuteRunActiveDays} active run day(s) in the 7d window (need >= 3 for primary_sport_monotony)`);
  }

  // 4. Populated, low-intensity-dominant zone distribution.
  if (acuteZoneTotal <= 0) {
    fail(`7d zone-time total is ${acuteZoneTotal} → Seiler TID would be degenerate`);
  }
  const easyRatio = acuteEasy / acuteZoneTotal;
  if (!(easyRatio >= 0.7 && easyRatio <= 0.9)) {
    fail(`7d easy_time_ratio is ${easyRatio.toFixed(3)} (expected low-intensity-dominant ~0.80, band [0.70,0.90])`);
  }

  // Watts-fence self-check: no power field may appear anywhere in an activity.
  const POWER_KEYS = new Set([
    "average_watts",
    "icu_weighted_avg_watts",
    "watts",
    "icu_zone_times_watts",
    "icu_pm_p_max",
  ]);
  for (const act of fixture.activities) {
    for (const k of Object.keys(act)) {
      if (POWER_KEYS.has(k)) fail(`power field "${k}" present on a running-only activity`);
    }
  }
}

function main(argv: string[]): void {
  const args = parseFixtureArgs(argv, { frozenNow: DEFAULT_FROZEN_NOW, out: DEFAULT_OUT });
  const fixture = buildFixture(args.frozenNow);
  assertNonVacuous(fixture, args.frozenNow);
  writeFixtureWithChecksum(args.out, fixture);
}

runFixtureCli(import.meta.url, main);

export { buildFixture, ymdMinus };
