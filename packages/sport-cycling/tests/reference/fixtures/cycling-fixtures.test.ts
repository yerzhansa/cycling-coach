// Substrate gates for the cycling adapter fixtures: parse against the public
// FixtureSchema, byte-for-byte determinism, non-vacuity, and the privacy
// invariants. Projection VALUES (sufficient flags, anchorsCovered, trend) are
// engineered into the JSON but asserted by the projection suite that owns the
// core-internal computes — this file cannot reach across the package boundary,
// so it pins shape and the gate-relevant structure only.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { FixtureSchema } from "@enduragent/core";
import { describe, expect, it } from "vitest";

import {
  recomputeSufficiency,
  type StreamChannels,
} from "./_helpers/dfa-stream-synthesizer.js";
import {
  assertNonVacuous,
  buildAllFixtures,
  FIXTURE_FILENAMES,
  POWER_CURVE_ANCHORS,
  serializeFixture,
} from "./_helpers/build-cycling-adapter-fixtures.js";

const FIXTURE_DIR = dirname(fileURLToPath(import.meta.url));
const POWER_ANCHOR_SET = new Set<number>(POWER_CURVE_ANCHORS);

function loadRaw(filename: string): unknown {
  return JSON.parse(readFileSync(resolve(FIXTURE_DIR, filename), "utf-8"));
}

interface PowerCurveEntry {
  id: string;
  secs: number[];
  watts: (number | null)[];
}
interface ParsedFixture {
  activities: { id: number | string; start_date_local: string }[];
  streams?: Record<string, StreamChannels>;
  power_curves?: { list: PowerCurveEntry[] };
}

const ALL = Object.values(FIXTURE_FILENAMES);
const DFA_FILES = [
  FIXTURE_FILENAMES.cleanDfa,
  FIXTURE_FILENAMES.noisyDfa,
  FIXTURE_FILENAMES.shortDfa,
];

describe("cycling adapter fixtures — schema", () => {
  it.each(ALL)("%s parses against the public FixtureSchema", (filename) => {
    const result = FixtureSchema.safeParse(loadRaw(filename));
    expect(result.success).toBe(true);
  });

  it.each(ALL)("%s carries the three strict-required top-level arrays", (filename) => {
    const raw = loadRaw(filename) as Record<string, unknown>;
    expect(Array.isArray(raw.activities)).toBe(true);
    expect(Array.isArray(raw.wellness)).toBe(true);
    expect(Array.isArray(raw.ftp_history)).toBe(true);
  });
});

describe("cycling adapter fixtures — determinism", () => {
  it.each(ALL)("%s on disk is byte-identical to a fresh rebuild", (filename) => {
    const fixtures = buildAllFixtures();
    const rebuilt = serializeFixture(fixtures[filename]);
    const onDisk = readFileSync(resolve(FIXTURE_DIR, filename), "utf-8");
    expect(rebuilt).toBe(onDisk);
  });

  it("a fresh build clears the non-vacuity guard", () => {
    expect(() => assertNonVacuous(buildAllFixtures())).not.toThrow();
  });
});

describe("cycling adapter fixtures — DFA non-vacuity", () => {
  function streamOf(filename: string): StreamChannels {
    const parsed = loadRaw(filename) as ParsedFixture;
    const id = parsed.activities[0]?.id;
    const ch = parsed.streams?.[String(id)];
    expect(ch, `${filename} must carry a stream record for activity ${id}`).toBeDefined();
    return ch as StreamChannels;
  }

  it.each(DFA_FILES)("%s carries an index-aligned per-second dfa_a1 stream", (filename) => {
    const ch = streamOf(filename);
    expect(Array.isArray(ch.dfa_a1)).toBe(true);
    expect(ch.dfa_a1.length).toBeGreaterThan(0);
    expect(ch.artifacts.length).toBe(ch.dfa_a1.length);
    expect(ch.heartrate.length).toBe(ch.dfa_a1.length);
    expect(ch.watts.length).toBe(ch.dfa_a1.length);
  });

  it("clean fixture clears the gate by a clear margin", () => {
    const s = recomputeSufficiency(streamOf(FIXTURE_FILENAMES.cleanDfa));
    expect(s.sufficient).toBe(true);
    expect(s.validSecs).toBeGreaterThanOrEqual(1200);
    expect(s.validPct).toBeGreaterThanOrEqual(70);
  });

  it("noisy fixture fails the percentage gate (validPct < 70)", () => {
    const s = recomputeSufficiency(streamOf(FIXTURE_FILENAMES.noisyDfa));
    expect(s.sufficient).toBe(false);
    expect(s.validPct).toBeLessThan(70);
  });

  it("short fixture fails the duration gate (validSecs < 1200)", () => {
    const s = recomputeSufficiency(streamOf(FIXTURE_FILENAMES.shortDfa));
    expect(s.sufficient).toBe(false);
    expect(s.validSecs).toBeLessThan(1200);
  });
});

describe("cycling adapter fixtures — power-curve coverage", () => {
  function curvesOf(filename: string): { current?: PowerCurveEntry; previous?: PowerCurveEntry } {
    const parsed = loadRaw(filename) as ParsedFixture;
    const list = parsed.power_curves?.list ?? [];
    // Window ids resolve in the same order the curator emits: current first,
    // previous second (the builder writes them in that order).
    return { current: list[0], previous: list[1] };
  }

  it("full-power-history covers all five anchors in both windows", () => {
    const { current, previous } = curvesOf(FIXTURE_FILENAMES.fullPower);
    expect(current?.secs).toEqual([...POWER_CURVE_ANCHORS]);
    expect(previous?.secs).toEqual([...POWER_CURVE_ANCHORS]);
  });

  it("partial-power-history keeps ≥3 anchors per window (no null block) but overlaps on exactly 2", () => {
    const { current, previous } = curvesOf(FIXTURE_FILENAMES.partialPower);
    // Each window has ≥3 valid anchor durations so neither trips the <3 null block.
    expect(current!.secs.length).toBeGreaterThanOrEqual(3);
    expect(previous!.secs.length).toBeGreaterThanOrEqual(3);
    // Every duration is a member of the shipped anchor set.
    for (const c of [current!, previous!]) {
      for (const s of c.secs) expect(POWER_ANCHOR_SET.has(s)).toBe(true);
    }
    // Exactly two anchors are present-and-positive in BOTH windows → the
    // projection covers two anchors (the engineered anchorsCovered:2 handoff).
    const positive = (c: PowerCurveEntry, secs: number): boolean => {
      const idx = c.secs.indexOf(secs);
      const v = idx >= 0 ? c.watts[idx] : null;
      return v != null && v > 0;
    };
    const bothSide = [...POWER_CURVE_ANCHORS].filter(
      (s) => positive(current!, s) && positive(previous!, s),
    );
    expect(bothSide).toHaveLength(2);
    // The rotation set {5,60,1200,3600} is not fully both-side covered → the
    // projection's trend stays null.
    const rotationCovered = [5, 60, 1200, 3600].every(
      (s) => positive(current!, s) && positive(previous!, s),
    );
    expect(rotationCovered).toBe(false);
  });
});

describe("cycling adapter fixtures — privacy invariants", () => {
  it.each(ALL)("%s uses reserved bare-integer ids (≥90201) and pre-2015 dates", (filename) => {
    const parsed = loadRaw(filename) as ParsedFixture;
    for (const act of parsed.activities) {
      expect(typeof act.id).toBe("number");
      expect(act.id as number).toBeGreaterThanOrEqual(90201);
      const year = Number(String(act.start_date_local).slice(0, 4));
      expect(year).toBeLessThan(2015);
    }
    for (const entry of parsed.power_curves?.list ?? []) {
      // Curve ids embed the window dates; assert every embedded year is pre-2015.
      for (const m of entry.id.matchAll(/(\d{4})-\d{2}-\d{2}/g)) {
        expect(Number(m[1])).toBeLessThan(2015);
      }
    }
  });
});
