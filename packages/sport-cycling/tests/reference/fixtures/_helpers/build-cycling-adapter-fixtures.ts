// Deterministic builder for the Reference layer's cycling adapter test
// substrate. Run-once, check-in-JSON: each fixture is serialized with 2-space
// indent + a trailing newline and is byte-identical across re-runs (no
// wall-clock read, no runtime RNG — noise comes from a seeded integer LCG and
// every date is derived from the single exported synthetic-epoch anchor).
//
// Cross-PR contract: FIXTURE_FROZEN_NOW is the canonical clock for the
// power-curve window ids (`r.<start>.<end>`). The projection test that drives
// computePowerCurveDelta MUST pass this exact value as `frozenNow`, or the
// window ids will not resolve and every power fixture silently collapses to a
// null block. The constant is exported for that reuse.
//
// CLI (operator, dev-time), regenerating the checked-in JSON:
//   pnpm exec tsx packages/sport-cycling/tests/reference/fixtures/_helpers/build-cycling-adapter-fixtures.ts

import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";

import {
  buildCleanStream,
  degradeBelowValidPct,
  recomputeSufficiency,
  type StreamChannels,
} from "./dfa-stream-synthesizer.js";

/** Synthetic-epoch anchor (pre-2015). Canonical clock for the window ids. */
export const FIXTURE_FROZEN_NOW = "1998-06-04T12:00:00";

/** Reserved bare-integer id range for the synthetic DFA/curve activities. */
const SYNTHETIC_ID_BASE = 90201;

/** The shipped power-curve anchor set, in seconds. */
export const POWER_CURVE_ANCHORS = [5, 60, 300, 1200, 3600] as const;

const FIXTURE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ─── Date / window math ─────────────────────────────────────────────────────
// Mirrors the curator's isoDateDaysBefore exactly: parse as a UTC date, subtract
// whole days, format %Y-%m-%d. The power-curve window tuple is
// current = [now-27, today], previous = [now-55, now-28].
function ymdMinus(frozenNow: string, days: number): string {
  const datePart = frozenNow.slice(0, 10);
  const [y, m, d] = datePart.split("-").map(Number) as [number, number, number];
  const utc = new Date(Date.UTC(y, m - 1, d));
  utc.setUTCDate(utc.getUTCDate() - days);
  return utc.toISOString().slice(0, 10);
}

interface CurveWindows {
  currentId: string;
  previousId: string;
}

function curveWindows(frozenNow: string): CurveWindows {
  const today = frozenNow.slice(0, 10);
  return {
    currentId: `r.${ymdMinus(frozenNow, 27)}.${today}`,
    previousId: `r.${ymdMinus(frozenNow, 55)}.${ymdMinus(frozenNow, 28)}`,
  };
}

function powerCurveId(label: "current" | "previous", w: CurveWindows): string {
  return label === "current" ? w.currentId : w.previousId;
}

// ─── Fixture shapes ─────────────────────────────────────────────────────────
interface Activity {
  id: number;
  start_date_local: string;
  type: string;
  name: string;
  moving_time: number;
  elapsed_time: number;
}

interface PowerCurveEntry {
  id: string;
  secs: number[];
  watts: (number | null)[];
}

interface CyclingFixture {
  activities: Activity[];
  wellness: Record<string, unknown>[];
  ftp_history: unknown[];
  streams?: Record<string, StreamChannels>;
  power_curves?: { list: PowerCurveEntry[] };
}

function rideActivity(id: number, frozenNow: string, durationSecs: number): Activity {
  // One ride day before the anchor, so it sits in the trailing window.
  const date = ymdMinus(frozenNow, 1);
  return {
    id,
    start_date_local: `${date}T07:00:00`,
    type: "Ride",
    name: "synthetic-cycling-ride",
    moving_time: durationSecs,
    elapsed_time: durationSecs,
  };
}

// ─── DFA fixtures ───────────────────────────────────────────────────────────
function buildCleanDfa(frozenNow: string): CyclingFixture {
  const id = SYNTHETIC_ID_BASE;
  // 1800s of all-valid aerobic α1 → validSecs=1800, validPct=100 (clear margin).
  const ch = buildCleanStream(1800);
  return {
    activities: [rideActivity(id, frozenNow, 1800)],
    wellness: [],
    ftp_history: [],
    streams: { [String(id)]: ch },
  };
}

function buildNoisyDfa(frozenNow: string): CyclingFixture {
  const id = SYNTHETIC_ID_BASE + 1;
  // 1800s base, ~50% of seconds corrupted above the artifact ceiling → validPct
  // lands near 50, well under the 70 gate. Seeded so the placement is fixed.
  const ch = degradeBelowValidPct(buildCleanStream(1800), 0x5eed_1, 0.5);
  return {
    activities: [rideActivity(id, frozenNow, 1800)],
    wellness: [],
    ftp_history: [],
    streams: { [String(id)]: ch },
  };
}

function buildShortDfa(frozenNow: string): CyclingFixture {
  const id = SYNTHETIC_ID_BASE + 2;
  // 300s all-valid → validPct=100 but validSecs=300 < 1200 → insufficient on
  // duration, independent of the percentage gate.
  const ch = buildCleanStream(300);
  return {
    activities: [rideActivity(id, frozenNow, 300)],
    wellness: [],
    ftp_history: [],
    streams: { [String(id)]: ch },
  };
}

// ─── Power-curve fixtures ───────────────────────────────────────────────────
function buildFullPowerHistory(frozenNow: string): CyclingFixture {
  const id = SYNTHETIC_ID_BASE + 3;
  const w = curveWindows(frozenNow);
  // Both windows carry all 5 anchors with positive watts. Rotation anchors
  // {5,60,1200,3600}: sprint anchors gain +10%, endurance anchors gain +1% →
  // rotation_index = mean(+10,+10) − mean(+1,+1) = +9, a clear positive margin
  // (sprint-biased) → determinate non-null trend.
  const previous: PowerCurveEntry = {
    id: powerCurveId("previous", w),
    secs: [5, 60, 300, 1200, 3600],
    watts: [1000, 500, 400, 300, 250],
  };
  const current: PowerCurveEntry = {
    id: powerCurveId("current", w),
    secs: [5, 60, 300, 1200, 3600],
    watts: [1100, 550, 420, 303, 252.5],
  };
  return {
    activities: [rideActivity(id, frozenNow, 3600)],
    wellness: [],
    ftp_history: [],
    power_curves: { list: [current, previous] },
  };
}

function buildPartialPowerHistory(frozenNow: string): CyclingFixture {
  const id = SYNTHETIC_ID_BASE + 4;
  const w = curveWindows(frozenNow);
  // Each window carries ≥3 anchor durations (so neither window trips the
  // <3-anchor null block), but only {60,300} are present-and-positive in BOTH
  // windows → exactly 2 anchors carry a non-null pct_change → anchorsCovered:2.
  // The rotation set {5,60,1200,3600} is not fully both-side covered (only 60s),
  // so rotation_index stays null → trend null.
  const previous: PowerCurveEntry = {
    id: powerCurveId("previous", w),
    secs: [5, 60, 300],
    watts: [1000, 500, 400],
  };
  const current: PowerCurveEntry = {
    id: powerCurveId("current", w),
    secs: [60, 300, 1200],
    watts: [550, 420, 303],
  };
  return {
    activities: [rideActivity(id, frozenNow, 3600)],
    wellness: [],
    ftp_history: [],
    power_curves: { list: [current, previous] },
  };
}

// ─── Registry of named fixtures ─────────────────────────────────────────────
export const FIXTURE_FILENAMES = {
  cleanDfa: "clean-dfa-z2-ride.json",
  noisyDfa: "noisy-dfa-z2-ride.json",
  shortDfa: "short-recording-dfa.json",
  partialPower: "partial-power-history.json",
  fullPower: "full-power-history.json",
} as const;

export function buildAllFixtures(
  frozenNow: string = FIXTURE_FROZEN_NOW,
): Record<string, CyclingFixture> {
  return {
    [FIXTURE_FILENAMES.cleanDfa]: buildCleanDfa(frozenNow),
    [FIXTURE_FILENAMES.noisyDfa]: buildNoisyDfa(frozenNow),
    [FIXTURE_FILENAMES.shortDfa]: buildShortDfa(frozenNow),
    [FIXTURE_FILENAMES.partialPower]: buildPartialPowerHistory(frozenNow),
    [FIXTURE_FILENAMES.fullPower]: buildFullPowerHistory(frozenNow),
  };
}

/** Serialize a fixture the way the checked-in JSON is written: 2-space indent,
 *  trailing newline. The determinism test compares these bytes against disk. */
export function serializeFixture(fixture: CyclingFixture): string {
  return `${JSON.stringify(fixture, null, 2)}\n`;
}

// ─── Non-vacuity guard ──────────────────────────────────────────────────────
// Recompute sufficiency/coverage from the documented thresholds and throw if a
// parity-green-but-vacuous fixture would ship: a "clean" DFA that does not clear
// the gate, a "noisy"/"short" that accidentally clears it, a "full" power
// history that does not cover all 5 anchors both-side, or a "partial" that does
// not land on exactly 2 covered anchors with a null rotation.
function anchorCoverage(fixture: CyclingFixture): {
  bothSideCovered: number;
  rotationFullyCovered: boolean;
  perWindowAnchorCount: { current: number; previous: number };
} {
  const list = fixture.power_curves?.list ?? [];
  const w = curveWindows(FIXTURE_FROZEN_NOW);
  const byId = new Map(list.map((c) => [c.id, c]));
  const current = byId.get(w.currentId);
  const previous = byId.get(w.previousId);
  const wattAt = (c: PowerCurveEntry | undefined, secs: number): number | null => {
    if (!c) return null;
    const idx = c.secs.indexOf(secs);
    if (idx < 0) return null;
    const v = c.watts[idx];
    return v != null && v > 0 ? v : null;
  };
  let bothSideCovered = 0;
  const rotationSet = [5, 60, 1200, 3600];
  let rotationCovered = 0;
  for (const secs of POWER_CURVE_ANCHORS) {
    const cur = wattAt(current, secs);
    const prev = wattAt(previous, secs);
    if (cur != null && prev != null) {
      bothSideCovered++;
      if (rotationSet.includes(secs)) rotationCovered++;
    }
  }
  const validCount = (c: PowerCurveEntry | undefined): number =>
    POWER_CURVE_ANCHORS.filter((s) => wattAt(c, s) != null).length;
  return {
    bothSideCovered,
    rotationFullyCovered: rotationCovered === rotationSet.length,
    perWindowAnchorCount: { current: validCount(current), previous: validCount(previous) },
  };
}

export function assertNonVacuous(fixtures: Record<string, CyclingFixture>): void {
  const fail = (msg: string): never => {
    throw new Error(`[build-cycling-adapter-fixtures] non-vacuity guard failed: ${msg}`);
  };

  const dfaOf = (name: string): StreamChannels => {
    const f = fixtures[name];
    const id = f.activities[0]?.id;
    const ch = f.streams?.[String(id)];
    if (!ch) fail(`${name}: no stream record joined to activity ${id}`);
    return ch as StreamChannels;
  };

  const clean = recomputeSufficiency(dfaOf(FIXTURE_FILENAMES.cleanDfa));
  if (!clean.sufficient || clean.validSecs < 1200 || clean.validPct < 70) {
    fail(`clean DFA not sufficient (validSecs=${clean.validSecs}, validPct=${clean.validPct})`);
  }
  // Off-boundary check: a "clean" fixture must clear by a clear margin, not sit
  // on the 70% edge where rounding could flip the gate.
  if (clean.validPct < 90) fail(`clean DFA validPct=${clean.validPct} too close to the gate`);

  const noisy = recomputeSufficiency(dfaOf(FIXTURE_FILENAMES.noisyDfa));
  if (noisy.sufficient || noisy.validPct >= 70) {
    fail(`noisy DFA unexpectedly sufficient (validPct=${noisy.validPct})`);
  }
  if (noisy.validPct > 60) fail(`noisy DFA validPct=${noisy.validPct} too close to the gate`);

  const short = recomputeSufficiency(dfaOf(FIXTURE_FILENAMES.shortDfa));
  if (short.sufficient || short.validSecs >= 1200) {
    fail(`short DFA unexpectedly sufficient (validSecs=${short.validSecs})`);
  }

  const full = anchorCoverage(fixtures[FIXTURE_FILENAMES.fullPower]);
  if (full.bothSideCovered !== 5) {
    fail(`full power history covers ${full.bothSideCovered} anchors both-side (need 5)`);
  }
  if (!full.rotationFullyCovered) fail(`full power history rotation anchors not fully covered`);

  const partial = anchorCoverage(fixtures[FIXTURE_FILENAMES.partialPower]);
  if (partial.bothSideCovered !== 2) {
    fail(`partial power history covers ${partial.bothSideCovered} anchors both-side (need 2)`);
  }
  if (partial.rotationFullyCovered) {
    fail(`partial power history must NOT fully cover the rotation anchors`);
  }
  if (partial.perWindowAnchorCount.current < 3 || partial.perWindowAnchorCount.previous < 3) {
    fail(
      `partial power history must keep ≥3 anchors per window to avoid the null block ` +
        `(current=${partial.perWindowAnchorCount.current}, previous=${partial.perWindowAnchorCount.previous})`,
    );
  }
}

// ─── CLI write path ─────────────────────────────────────────────────────────
function main(): void {
  const fixtures = buildAllFixtures();
  assertNonVacuous(fixtures);
  for (const [filename, fixture] of Object.entries(fixtures)) {
    const json = serializeFixture(fixture);
    const out = resolve(FIXTURE_DIR, filename);
    writeFileSync(out, json);
    const hash = createHash("sha256").update(json).digest("hex");
    // eslint-disable-next-line no-console
    console.error(`Wrote ${out} (${json.length} bytes, sha256 ${hash.slice(0, 12)})`);
  }
}

const isCli =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1]}`;

if (isCli) {
  main();
}
