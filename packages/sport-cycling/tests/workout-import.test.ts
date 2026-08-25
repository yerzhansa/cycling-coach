import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CYCLING_WORKOUT_PARSER_VERSION,
  WorkoutParseError,
  parseNormalizedWorkoutSet,
  parseWorkoutBytes,
  type WorkoutParserLimits,
  type WorkoutSourceFormat,
} from "../src/workout-import/index.js";

const limits: WorkoutParserLimits = {
  candidates: 50,
  segmentsPerWorkout: 5_000,
  durationSeconds: 86_400,
  diagnostics: 100,
  diagnosticChars: 240,
  titleChars: 200,
  purposeChars: 500,
};

function parse(sourceFormat: WorkoutSourceFormat, text: string) {
  const bytes = new TextEncoder().encode(text);
  return parseWorkoutBytes({
    bytes,
    sourceFormat,
    sourceSha256: createHash("sha256").update(bytes).digest("hex"),
    limits,
  });
}

const zwo = `<?xml version="1.0" encoding="UTF-8"?>
<workout_file>
  <name>VO2 step builder</name>
  <description>Build repeatable power.</description>
  <sportType>bike</sportType>
  <workout>
    <Warmup Duration="300" PowerLow="0.4" PowerHigh="0.7" />
    <SteadyState Duration="600" Power="0.8" Cadence="90" />
    <IntervalsT Repeat="2" OnDuration="120" OffDuration="60" OnPower="1.1" OffPower="0.5" />
    <Cooldown Duration="540" PowerLow="0.6" PowerHigh="0.4" />
  </workout>
</workout_file>`;

const mrc = `[COURSE HEADER]
VERSION = 2
FILE NAME = Tempo 3 x 12
DESCRIPTION = Sustainable tempo work
MINUTES PERCENT
[END COURSE HEADER]
[COURSE DATA]
0 50
10 50
10 88
30 88
30 55
40 55
[END COURSE DATA]`;

const erg = `[COURSE HEADER]
VERSION = 2
COURSE NAME = Absolute power
MINUTES WATTS
[END COURSE HEADER]
[COURSE DATA]
0 120 85
5 120 85
5 240 90
25 240 90
25 100 80
30 100 80
[END COURSE DATA]`;

describe("planned Workout parsing", () => {
  it("normalizes ZWO and deterministically expands repeated intervals", () => {
    const result = parse("zwo", zwo);
    expect(result).toMatchObject({
      schemaVersion: 1,
      sourceFormat: "zwo",
      parserVersion: CYCLING_WORKOUT_PARSER_VERSION,
      selectedWorkoutId: null,
    });
    expect(result.workouts[0]).toMatchObject({
      title: "VO2 step builder",
      purpose: "Build repeatable power.",
      sport: "cycling",
      durationSeconds: 1_800,
    });
    expect(result.workouts[0]?.segments).toHaveLength(7);
    expect(result.workouts[0]?.segments.at(-1)).toMatchObject({
      kind: "ramp",
      power: { kind: "ftp_fraction_range", low: 0.4, high: 0.6 },
    });
    expect(parse("zwo", zwo)).toEqual(result);
  });

  it("normalizes MRC step changes into ordered FTP-percent segments", () => {
    const result = parse("mrc", mrc);
    expect(result.workouts[0]).toMatchObject({
      title: "Tempo 3 x 12",
      purpose: "Sustainable tempo work",
      durationSeconds: 2_400,
    });
    expect(result.workouts[0]?.segments.map((segment) => segment.seconds)).toEqual([
      600, 1_200, 600,
    ]);
    expect(result.workouts[0]?.segments[1]).toMatchObject({
      kind: "steady",
      power: { kind: "ftp_percent_range", low: 88, high: 88 },
    });
  });

  it("normalizes ERG absolute-watt targets and cadence", () => {
    const result = parse("erg", erg);
    expect(result.workouts[0]).toMatchObject({
      title: "Absolute power",
      durationSeconds: 1_800,
    });
    expect(result.workouts[0]?.segments[1]).toMatchObject({
      power: { kind: "watts_range", low: 240, high: 240 },
      cadenceRpm: { low: 90, high: 90 },
    });
  });

  it.each([
    [
      "doctype",
      zwo.replace("<workout_file>", '<!DOCTYPE workout_file [<!ENTITY x "bad">]><workout_file>'),
    ],
    ["processing instruction", zwo.replace("<workout_file>", "<?unsafe value?><workout_file>")],
    [
      "unknown executable construct",
      zwo.replace("<SteadyState", "<Script").replace("</workout>", "</workout>"),
    ],
  ])("rejects unsafe ZWO %s", (_name, content) => {
    expect(() => parse("zwo", content)).toThrow(WorkoutParseError);
  });

  it.each([
    mrc.replace("30 55\n40 55", "30 55\n29 55"),
    mrc.replace("10 88", "10 0"),
    mrc.replace("40 55", "40 NaN"),
    mrc.replace("MINUTES PERCENT", "MINUTES WATTS"),
  ])("rejects invalid MRC timing, target, or grammar", (content) => {
    expect(() => parse("mrc", content)).toThrow(WorkoutParseError);
  });

  it("fails before expanding an excessive ZWO repeat count", () => {
    const content = zwo.replace('Repeat="2"', 'Repeat="5001"');
    expect(() => parse("zwo", content)).toThrowError(
      expect.objectContaining({ code: "limit_exceeded" }),
    );
  });

  it("rejects malformed UTF-8 before grammar parsing", () => {
    expect(() =>
      parseWorkoutBytes({
        bytes: new Uint8Array([0xc3, 0x28]),
        sourceFormat: "zwo",
        sourceSha256: "a".repeat(64),
        limits,
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_utf8" }));
  });

  it("rejects a selected Workout id that is outside the parsed set", () => {
    const result = parse("erg", erg);
    expect(() =>
      parseNormalizedWorkoutSet({ ...result, selectedWorkoutId: "missing" }, limits),
    ).toThrow();
  });
});
