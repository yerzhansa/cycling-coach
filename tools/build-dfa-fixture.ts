// Builds the `dfa-equipped` golden fixture: a FULLY SYNTHETIC bundle of cycling
// rides carrying per-second DFA-a1 streams in the top-level `streams` record
// (keyed by String(activity.id)). No real data, no sanitizer involvement — every
// byte is generated from closed-form segment patterns here.
//
// The upstream's own _compute_dfa_block consumes a per-second `dfa_a1` channel
// as an INPUT (the recording filters + rolls up; it does not derive a1 from
// R-R), so embedding synthetic per-second dfa_a1 is exactly the shape the
// protocol reads. The harness joins this `streams` record back to the activities
// array and runs each session through _compute_dfa_block, then the profile path
// aggregates the trailing window.
//
// Confidence target = "high": each session carries >= 60s of dfa_a1 inside BOTH
// the LT1 band [0.95,1.05] and the LT2 band [0.45,0.55] with co-present
// heartrate + watts, and >= 1200 valid seconds at >= 70% valid_pct. With 7
// qualifying sessions the crossing-band session count reaches >= 6, which the
// protocol maps to "high".
//
// Determinism: no Math.random / Date.now. Streams come from explicit per-session
// segment patterns; re-running produces byte-identical output. The build ends
// with a non-vacuity guard that independently recomputes sufficiency + the
// crossing-band counters and fails unless they clear the high-confidence
// threshold — so a "parity-green-but-vacuous" fixture can never ship.
//
// Usage (operator, dev-time):
//   pnpm exec tsx tools/build-dfa-fixture.ts [--frozen-now 2026-06-04T12:00:00] [--out <path>]

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUT = resolve(REPO_ROOT, "packages/core/tests/fixtures/golden/dfa-equipped.json");
const DEFAULT_FROZEN_NOW = "2026-06-04T12:00:00";

// Synthetic id base, well above the real-data sentinel and the curve fixture's
// 90101 base, so the two synthetic fixtures never collide.
const SYNTHETIC_ID_BASE = 90201;
const N_SESSIONS = 7; // fills the trailing window (N=7) and clears crossing_n >= 6

// Protocol constants (mirror the upstream's DFA_* class attributes; the guard
// recomputes against these so the fixture self-certifies confidence=high).
const DFA_MIN_VALID_VALUE = 0.01;
const DFA_ARTIFACT_MAX_PCT = 5.0;
const DFA_MIN_DURATION_SECS = 1200;
const DFA_SUFFICIENT_MIN_VALID_PCT = 70.0;
const DFA_MIN_CROSSING_DWELL_SECS = 60;
const LT1_CENTER = 1.0;
const LT2_CENTER = 0.5;
const CROSSING_BAND = 0.05;
const HIGH_CONFIDENCE_MIN_CROSSING_N = 6;

// Per-session stream layout: three 600s segments → 1800s total, all valid.
const SEGMENT_SECS = 600;
const SESSION_SECS = SEGMENT_SECS * 3;

// dfa_a1 segment centers: LT1 band center, mid (transition), LT2 band center.
// Exact binary fractions so no pyodide-vs-CPython float drift on the rollup.
const DFA_LT1_SEGMENT = 1.0;
const DFA_MID_SEGMENT = 0.75;
const DFA_LT2_SEGMENT = 0.5;

interface Args {
  frozenNow: string;
  out: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { frozenNow: DEFAULT_FROZEN_NOW, out: DEFAULT_OUT };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) {
        throw new Error(`flag ${arg} requires a value`);
      }
      i++;
      return v;
    };
    switch (arg) {
      case "--frozen-now":
        out.frozenNow = next();
        break;
      case "--out":
        out.out = resolve(next());
        break;
      default:
        throw new Error(`unknown flag: ${arg}`);
    }
  }
  return out;
}

// Python-equivalent calendar math: parse the anchor as a UTC date, subtract
// whole days, format %Y-%m-%d. Matches `datetime - timedelta(days=n)` exactly.
function ymdMinus(frozenNow: string, days: number): string {
  const base = new Date(`${frozenNow.slice(0, 10)}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() - days);
  return base.toISOString().slice(0, 10);
}

interface StreamChannels {
  dfa_a1: number[];
  artifacts: number[];
  heartrate: number[];
  watts: number[];
}

// Build one session's four per-second channels from the segment pattern. HR and
// watts vary by session index (deterministic, distinct per session) while the
// dfa_a1 centers stay fixed so band membership is guaranteed regardless of index.
function buildStreams(sessionIndex: number): StreamChannels {
  const dfa_a1: number[] = [];
  const artifacts: number[] = [];
  const heartrate: number[] = [];
  const watts: number[] = [];

  const pushSegment = (dfa: number, hr: number, w: number): void => {
    for (let s = 0; s < SEGMENT_SECS; s++) {
      dfa_a1.push(dfa);
      artifacts.push(0.0);
      heartrate.push(hr);
      watts.push(w);
    }
  };

  // LT1 (aerobic) → mid (transition) → LT2 (supra-threshold). Distinct HR/watts
  // per band and per session so the in-band averages are non-trivial.
  pushSegment(DFA_LT1_SEGMENT, 138 + sessionIndex, 175 + sessionIndex * 2);
  pushSegment(DFA_MID_SEGMENT, 150 + sessionIndex, 210 + sessionIndex * 2);
  pushSegment(DFA_LT2_SEGMENT, 166 + sessionIndex, 255 + sessionIndex * 2);

  return { dfa_a1, artifacts, heartrate, watts };
}

interface BuiltFixture {
  activities: Record<string, unknown>[];
  wellness: Record<string, unknown>[];
  ftp_history: unknown[];
  streams: Record<string, StreamChannels>;
}

function buildFixture(frozenNow: string): BuiltFixture {
  const activities: Record<string, unknown>[] = [];
  const wellness: Record<string, unknown>[] = [];
  const streams: Record<string, StreamChannels> = {};

  // Seven consecutive ride days ending the day before the anchor, so every
  // session sits in the trailing window and the dates sort deterministically.
  // Oldest first → newest last (index 6 is the most recent).
  for (let i = 0; i < N_SESSIONS; i++) {
    const id = SYNTHETIC_ID_BASE + i;
    const date = ymdMinus(frozenNow, N_SESSIONS - i); // i=0 → now-7 ... i=6 → now-1
    activities.push({
      id,
      start_date_local: `${date}T07:00:00`,
      type: "Ride",
      name: "synthetic-dfa-ride",
      moving_time: SESSION_SECS,
      elapsed_time: SESSION_SECS,
      icu_training_load: 60,
      // Nullable activity fields the upstream reads per-activity via dict.get().
      // Present-but-null so the harness's contract tracker doesn't flag them as
      // silently-missing keys (this fixture targets dfa_a1_profile only, so the
      // metrics that read these legitimately see no signal).
      decoupling: null,
      icu_efficiency_factor: null,
      icu_zone_times: null,
    });
    streams[String(id)] = buildStreams(i);
    // Minimal wellness row per ride day so the harness's wellness-window slice
    // has rows to read (no sportInfo / athlete / curve keys — this fixture
    // targets dfa_a1_profile only). hrv/restingHR are the schema-required
    // nullable fields; sleep fields kept null.
    wellness.push({
      id: date,
      weight: null,
      restingHR: 50,
      hrv: 70,
      sleepSecs: null,
      sleepQuality: null,
    });
  }

  return { activities, wellness, ftp_history: [], streams };
}

// ─── Non-vacuity guard ─────────────────────────────────────────────────────
// Recompute sufficiency + the crossing-band counters independently (plain TS
// arithmetic mirroring the documented thresholds) and fail the build unless the
// streams↔activities join yields >= 7 entries, every session is sufficient, and
// the crossing counter reaches the high-confidence threshold.
function assertNonVacuous(fixture: BuiltFixture): void {
  const fail = (msg: string): never => {
    throw new Error(`[build-dfa-fixture] non-vacuity guard failed: ${msg}`);
  };

  // 1. Join: every activity id resolves to a stream record with a dfa_a1 channel.
  const joined: { id: number; ch: StreamChannels }[] = [];
  for (const act of fixture.activities) {
    const rec = fixture.streams[String(act.id)];
    if (rec && Array.isArray(rec.dfa_a1) && rec.dfa_a1.length > 0) {
      joined.push({ id: act.id as number, ch: rec });
    }
  }
  if (joined.length < N_SESSIONS) {
    fail(`streams↔activities join yielded ${joined.length} entries (< ${N_SESSIONS})`);
  }

  // Per-session: recompute the upstream's filter + crossing-band logic.
  let lt1CrossingSessions = 0;
  let lt2CrossingSessions = 0;
  for (const { id, ch } of joined) {
    const n = ch.dfa_a1.length;
    if (ch.artifacts.length !== n || ch.heartrate.length !== n || ch.watts.length !== n) {
      fail(`session ${id} channel length mismatch`);
    }
    // valid second: dfa_a1 >= DFA_MIN_VALID_VALUE AND artifacts <= DFA_ARTIFACT_MAX_PCT.
    let validSecs = 0;
    let lt1Dwell = 0;
    let lt2Dwell = 0;
    let lt1HasHr = false;
    let lt1HasW = false;
    let lt2HasHr = false;
    let lt2HasW = false;
    for (let s = 0; s < n; s++) {
      const d = ch.dfa_a1[s];
      const a = ch.artifacts[s];
      if (d == null || d < DFA_MIN_VALID_VALUE) continue;
      if (a != null && a > DFA_ARTIFACT_MAX_PCT) continue;
      validSecs++;
      if (d >= LT1_CENTER - CROSSING_BAND && d <= LT1_CENTER + CROSSING_BAND) {
        lt1Dwell++;
        if (ch.heartrate[s] != null) lt1HasHr = true;
        if (ch.watts[s] != null) lt1HasW = true;
      }
      if (d >= LT2_CENTER - CROSSING_BAND && d <= LT2_CENTER + CROSSING_BAND) {
        lt2Dwell++;
        if (ch.heartrate[s] != null) lt2HasHr = true;
        if (ch.watts[s] != null) lt2HasW = true;
      }
    }
    const validPct = (100.0 * validSecs) / n;
    const sufficient =
      validSecs >= DFA_MIN_DURATION_SECS && validPct >= DFA_SUFFICIENT_MIN_VALID_PCT;
    if (!sufficient) {
      fail(
        `session ${id} not sufficient (valid_secs=${validSecs}, valid_pct=${validPct.toFixed(1)})`,
      );
    }
    // A session counts toward a crossing estimate only with >= dwell threshold
    // AND a non-null in-band average (co-present hr/watts).
    if (lt1Dwell >= DFA_MIN_CROSSING_DWELL_SECS && (lt1HasHr || lt1HasW)) {
      lt1CrossingSessions++;
    }
    if (lt2Dwell >= DFA_MIN_CROSSING_DWELL_SECS && (lt2HasHr || lt2HasW)) {
      lt2CrossingSessions++;
    }
  }

  // crossing_n = max over (lt1/lt2 × hr/watts) session counts. Both bands have
  // co-present hr+watts in every session here, so the per-band session counts
  // equal the per-quantity counts; max of the four is the crossing session count.
  const crossingN = Math.max(lt1CrossingSessions, lt2CrossingSessions);
  if (crossingN < HIGH_CONFIDENCE_MIN_CROSSING_N) {
    fail(
      `crossing_n=${crossingN} (< ${HIGH_CONFIDENCE_MIN_CROSSING_N} needed for confidence=high; ` +
        `lt1_sessions=${lt1CrossingSessions}, lt2_sessions=${lt2CrossingSessions})`,
    );
  }
}

function main(argv: string[]): void {
  const args = parseArgs(argv);
  const fixture = buildFixture(args.frozenNow);
  assertNonVacuous(fixture);

  const json = `${JSON.stringify(fixture, null, 2)}\n`;
  writeFileSync(args.out, json);
  const hash = createHash("sha256").update(json).digest("hex");
  writeFileSync(`${args.out}.sha256`, `${hash}  ${basename(args.out)}\n`);
  // eslint-disable-next-line no-console
  console.error(`Wrote ${args.out} (${json.length} bytes), checksum ${args.out}.sha256`);
}

const isCli =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1]}`;

if (isCli) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error((err as Error).message);
    process.exit(1);
  }
}

export { buildFixture, ymdMinus };
