// Builds the `capability-qualifying` golden fixture: the sanitized
// realistic-athlete base with five steady-state qualifying Rides appended to
// the tail of `activities`. The base is read from the committed
// realistic-athlete golden — already sanitized, id-redacted, and shifted to the
// synthetic epoch — so this builder never re-runs the sanitizer; it only
// appends. The appended Rides are de-identified at the source (synthetic
// 90001-90005 ids, 1998-epoch dates) and are attached AFTER / outside any
// sanitizer walk, exactly as the sibling curve builder attaches its synthetic
// blocks, so their literals must already sit in the synthetic epoch.
//
// The Rides are hardcoded verbatim rather than generated. Each one's field set
// (icu_hr_decoupling, bare-number icu_hrr, no fitnessAtEnd/fatigueAtEnd) is the
// raw intervals.icu API surface the durability/EF/HRRc metrics read directly,
// not the refreshed real-activity surface — copying them literally keeps the
// committed bytes pinned to the values the populated-branch coverage depends on.
//
// The build ends with a non-vacuity guard that independently recomputes the
// durability reliability gate from the OUTPUT — >= 3 qualifying steady-state
// Rides in the 7d window and >= 5 in the 28d window before the anchor — and
// fails the build unless it clears. That turns a "parity-green-but-vacuous"
// fixture (one that quietly drops below the gate and flips the means to null)
// into a hard build failure.
//
// Determinism: same base bytes -> byte-identical output. No Math.random /
// Date.now; the base is read from disk and the Rides are literals.
//
// Usage (operator, dev-time):
//   pnpm exec tsx tools/build-capability-fixture.ts \
//     [--frozen-now 1998-05-10T12:00:00] [--base <path>] [--out <path>]

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GOLDEN_DIR = resolve(REPO_ROOT, "packages/core/tests/fixtures/golden");
const DEFAULT_BASE = resolve(GOLDEN_DIR, "realistic-athlete.json");
const DEFAULT_OUT = resolve(GOLDEN_DIR, "capability-qualifying.json");
// Shares the realistic-athlete base, whose dates were shifted back one full
// Gregorian cycle to de-identify the real calendar, so the anchor sits in the
// synthetic epoch one day after the base's last activity. The durability
// windows the guard recomputes are taken relative to this clock.
const DEFAULT_FROZEN_NOW = "1998-05-10T12:00:00";

// Durability qualifying predicate (mirrors capability.ts filterQualifying /
// sync.py:4061-4078) and reliability gate (capability.ts computeDurability):
// a Ride qualifies when decoupling is present, VI is in (0, 1.05], and
// moving_time >= 90 min; the gate needs N7 >= 3 and N28 >= 5.
const VI_MAX = 1.05;
const MIN_MOVING_TIME_SECS = 5400;
const RELIABILITY_MIN_N7 = 3;
const RELIABILITY_MIN_N28 = 5;

interface Args {
  base: string;
  frozenNow: string;
  out: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    base: DEFAULT_BASE,
    frozenNow: DEFAULT_FROZEN_NOW,
    out: DEFAULT_OUT,
  };
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
      case "--base":
        out.base = resolve(next());
        break;
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
// whole days, format %Y-%m-%d. Matches the harness slice_window's inclusive
// [frozenNow-(days-1), frozenNow] date prefix comparison.
function ymdMinus(frozenNow: string, days: number): string {
  const base = new Date(`${frozenNow.slice(0, 10)}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() - days);
  return base.toISOString().slice(0, 10);
}

// The five qualifying Rides, verbatim. Field set + key order are the raw
// intervals.icu API surface the durability/EF/HRRc filters read: icu_hr_decoupling
// (the preferred decoupling field), bare-number icu_hrr, VI exactly 1.0, and a
// 6000s moving_time clearing the 90-min steady-state floor. Three land in the
// 7d window (05-06/05-08/05-10), all five in the 28d window. The 09:00:00
// wall-clock and 1998-epoch dates keep every literal de-identified.
const ZONE_TIMES = [
  { id: "Z1", secs: 600 },
  { id: "Z2", secs: 3000 },
  { id: "Z3", secs: 1500 },
  { id: "Z4", secs: 500 },
  { id: "Z5", secs: 200 },
  { id: "Z6", secs: 120 },
  { id: "Z7", secs: 80 },
  { id: "SS", secs: 600 },
];

interface QualifyingRide {
  id: number;
  start_date_local: string;
  type: string;
  name: string;
  moving_time: number;
  elapsed_time: number;
  icu_training_load: number;
  icu_intensity: number;
  average_heartrate: number;
  icu_zone_times: { id: string; secs: number }[];
  paired_event_id: number | null;
  pace_zone_times: number | null;
  icu_rpe: number | null;
  icu_variability_index: number;
  icu_hr_decoupling: number;
  icu_efficiency_factor: number;
  icu_hrr: number;
}

function qualifyingRide(
  id: number,
  date: string,
  decoupling: number,
  efficiencyFactor: number,
  hrr: number,
): QualifyingRide {
  return {
    id,
    start_date_local: `${date}T09:00:00`,
    type: "Ride",
    name: "Capability qualifier",
    moving_time: 6000,
    elapsed_time: 6100,
    icu_training_load: 90,
    icu_intensity: 79,
    average_heartrate: 140,
    icu_zone_times: ZONE_TIMES.map((z) => ({ ...z })),
    paired_event_id: null,
    pace_zone_times: null,
    icu_rpe: null,
    icu_variability_index: 1.0,
    icu_hr_decoupling: decoupling,
    icu_efficiency_factor: efficiencyFactor,
    icu_hrr: hrr,
  };
}

// Literal id order 90001->90005 (NOT re-sorted into the base's descending
// calendar). decoupling rises across the window so the 7d-vs-28d trend has
// signal; EF/HRR step down on the older two so the means differ between windows.
const QUALIFYING_RIDES: QualifyingRide[] = [
  qualifyingRide(90001, "1998-05-06", 1.0, 2.5, 40),
  qualifyingRide(90002, "1998-05-08", 2.0, 2.5, 40),
  qualifyingRide(90003, "1998-05-10", 3.0, 2.5, 40),
  qualifyingRide(90004, "1998-04-18", 6.0, 2.0, 30),
  qualifyingRide(90005, "1998-04-24", 7.0, 2.0, 30),
];

interface BaseFixture {
  activities: Record<string, unknown>[];
  [key: string]: unknown;
}

function buildFixture(basePath: string): BaseFixture {
  const base = JSON.parse(readFileSync(basePath, "utf8")) as BaseFixture;
  if (!Array.isArray(base.activities)) {
    throw new Error(`base fixture ${basePath} has no activities array`);
  }
  // Append the Rides to the tail in literal id order; preserve every other
  // top-level key (wellness, ftp_history, ...) and its insertion order.
  return {
    ...base,
    activities: [...base.activities, ...QUALIFYING_RIDES.map((r) => ({ ...r }))],
  };
}

// ─── Non-vacuity guard ─────────────────────────────────────────────────────
// Recompute the durability reliability gate from the OUTPUT, mirroring
// capability.ts: qualifying = decoupling present, VI in (0, 1.05], moving_time
// >= 5400s; window = inclusive [frozenNow-(days-1), frozenNow] date prefix.
// Fail unless N7 >= 3 and N28 >= 5 so the durability/EF/HRRc means stay
// populated (the whole reason this fixture exists).
function assertNonVacuous(fixture: BaseFixture, frozenNow: string): void {
  const fail = (msg: string): never => {
    throw new Error(`[build-capability-fixture] non-vacuity guard failed: ${msg}`);
  };

  const today = frozenNow.slice(0, 10);
  const inWindow = (act: Record<string, unknown>, days: number): boolean => {
    const sd = act.start_date_local;
    if (typeof sd !== "string") return false;
    const d = sd.slice(0, 10);
    return ymdMinus(frozenNow, days - 1) <= d && d <= today;
  };
  const isQualifying = (act: Record<string, unknown>): boolean => {
    let dec = act.icu_hr_decoupling as number | null | undefined;
    if (dec === null || dec === undefined) dec = act.decoupling as number | null | undefined;
    const vi = act.icu_variability_index as number | null | undefined;
    const mt = (act.moving_time as number | undefined) || 0;
    return (
      dec !== null &&
      dec !== undefined &&
      vi !== null &&
      vi !== undefined &&
      vi > 0 &&
      vi <= VI_MAX &&
      mt >= MIN_MOVING_TIME_SECS
    );
  };

  const n7 = fixture.activities.filter((a) => inWindow(a, 7) && isQualifying(a)).length;
  const n28 = fixture.activities.filter((a) => inWindow(a, 28) && isQualifying(a)).length;
  if (n7 < RELIABILITY_MIN_N7) {
    fail(`only ${n7} qualifying Rides in the 7d window (need >= ${RELIABILITY_MIN_N7})`);
  }
  if (n28 < RELIABILITY_MIN_N28) {
    fail(`only ${n28} qualifying Rides in the 28d window (need >= ${RELIABILITY_MIN_N28})`);
  }
}

function main(argv: string[]): void {
  const args = parseArgs(argv);
  const fixture = buildFixture(args.base);
  assertNonVacuous(fixture, args.frozenNow);

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

export { buildFixture, ymdMinus, QUALIFYING_RIDES };
