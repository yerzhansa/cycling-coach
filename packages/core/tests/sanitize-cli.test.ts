// Tests for the operator CLI at `tools/sanitize-fixture.ts`. The CLI is
// the operator-facing entry that pipes a real intervals.icu JSON dump
// through `sanitizeFixtureWithSummary` and writes the result under
// `tests/fixtures/golden/<name>.json` for committing.
//
// We test main() in-process with a tmpdir override for outputRoot so test
// runs don't pollute the committed fixture directory.

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TP_DENYLIST_FIELDS } from "../src/reference/trademark-policy.js";
import { main } from "../../../tools/sanitize-fixture.js";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function makeTmpDirs(): { inputDir: string; outputDir: string } {
  const inputDir = mkdtempSync(join(tmpdir(), "sanitize-cli-in-"));
  const outputDir = mkdtempSync(join(tmpdir(), "sanitize-cli-out-"));
  dirs.push(inputDir, outputDir);
  return { inputDir, outputDir };
}

describe("sanitize-fixture CLI — main()", () => {
  it("reads input JSON, sanitizes, writes the output to outputRoot, returns exit code 0", async () => {
    const { inputDir, outputDir } = makeTmpDirs();
    const inputPath = join(inputDir, "raw.json");
    writeFileSync(
      inputPath,
      JSON.stringify({
        id: 9876543,
        activity: { id: 1, name: "morning ride", kj: 1180 },
      }),
    );

    const exit = await main([inputPath, "tracer-output", "--force"], { outputRoot: outputDir });

    expect(exit).toBe(0);
    const written = JSON.parse(readFileSync(join(outputDir, "tracer-output.json"), "utf-8"));
    expect(written).toEqual({
      id: 12345,
      activity: { id: 12345, name: "sanitized", kj: 1180 },
    });
  });

  it("prints a summary listing dropped GPS keys and replaced fields; TP keys are gone before sanitize (rename strips them first)", async () => {
    const { inputDir, outputDir } = makeTmpDirs();
    const inputPath = join(inputDir, "raw.json");
    writeFileSync(
      inputPath,
      JSON.stringify({
        id: 1,
        activities: [
          {
            id: 2,
            start_latlng: [37, -122],
            description: "morning ride",
          },
          { id: 3, end_latlng: [38, -123], notes: "x" },
        ],
        wellness: [{ ctl: 52, atl: 39, contact: "x@y.z" }],
      }),
    );
    const lines: string[] = [];

    const exit = await main(
      [inputPath, "summary-output", "--force"],
      { outputRoot: outputDir, out: (m) => lines.push(m) },
    );

    expect(exit).toBe(0);
    const joined = lines.join("\n");
    expect(joined).toMatch(/Wrote sanitized fixture: .+summary-output\.json/);
    // After rename, the sanitize step sees zero TP keys to drop — the
    // "Dropped TP-trademark keys" line is absent on properly-shaped data.
    expect(joined).not.toMatch(/Dropped TP-trademark keys/);
    expect(joined).toMatch(/Dropped GPS keys.*start_latlng \(×1\)/);
    expect(joined).toMatch(/Dropped GPS keys.*end_latlng \(×1\)/);
    expect(joined).toMatch(/Replaced 3 id-shaped fields → mock; 1 emails → redacted/);
    expect(joined).toMatch(/Replaced free-text PII fields.*description.*notes/);
  });

  it("refuses to overwrite an existing fixture without --force; output is byte-identical", async () => {
    const { inputDir, outputDir } = makeTmpDirs();
    const inputPath = join(inputDir, "raw.json");
    writeFileSync(inputPath, JSON.stringify({ id: 1 }));

    // First run with --force → succeeds, writes file.
    await main([inputPath, "guarded-output", "--force"], { outputRoot: outputDir });
    const outputPath = join(outputDir, "guarded-output.json");
    const firstBytes = readFileSync(outputPath);
    const firstMtimeNs = statSync(outputPath).mtimeNs;

    // Second run WITHOUT --force, with mutated input → must refuse.
    writeFileSync(inputPath, JSON.stringify({ id: 2 }));
    const errs: string[] = [];
    const exit = await main([inputPath, "guarded-output"], {
      outputRoot: outputDir,
      err: (m) => errs.push(m),
    });

    expect(exit).not.toBe(0);
    expect(errs.join("\n")).toMatch(/refusing to overwrite .+--force/);
    // Output bytes unchanged.
    expect(readFileSync(outputPath).equals(firstBytes)).toBe(true);
    expect(statSync(outputPath).mtimeNs).toBe(firstMtimeNs);
  });

  it("with --force, overwrites the existing fixture", async () => {
    const { inputDir, outputDir } = makeTmpDirs();
    const inputPath = join(inputDir, "raw.json");
    writeFileSync(inputPath, JSON.stringify({ id: 1 }));

    await main([inputPath, "force-output", "--force"], { outputRoot: outputDir });
    const outputPath = join(outputDir, "force-output.json");
    const firstContent = readFileSync(outputPath, "utf-8");

    // Second run, mutated input, --force → overwrites.
    writeFileSync(inputPath, JSON.stringify({ id: 2, weight: 73.4 }));
    const exit = await main([inputPath, "force-output", "--force"], { outputRoot: outputDir });

    expect(exit).toBe(0);
    const secondContent = readFileSync(outputPath, "utf-8");
    expect(secondContent).not.toBe(firstContent);
    expect(JSON.parse(secondContent)).toEqual({ id: 12345, weight: 73.4 });
  });

  it("renames TP wellness fields to plain-English in the CLI output", async () => {
    const { inputDir, outputDir } = makeTmpDirs();
    const inputPath = join(inputDir, "raw.json");
    writeFileSync(
      inputPath,
      JSON.stringify({
        wellness: [
          {
            id: "2026-05-11",
            ctl: 50,
            atl: 38,
            ctlLoad: 12,
            atlLoad: 18,
            rampRate: 4.5,
            weight: 73.4,
          },
        ],
      }),
    );

    const exit = await main([inputPath, "rename-wellness", "--force"], {
      outputRoot: outputDir,
    });

    expect(exit).toBe(0);
    const written = JSON.parse(
      readFileSync(join(outputDir, "rename-wellness.json"), "utf-8"),
    );
    expect(written.wellness[0].fitness).toBe(50);
    expect(written.wellness[0].fatigue).toBe(38);
    expect(written.wellness[0].fitnessContribution).toBe(12);
    expect(written.wellness[0].fatigueContribution).toBe(18);
    expect(written.wellness[0].weeklyFitnessChange).toBe(4.5);
    expect(written.wellness[0]).not.toHaveProperty("ctl");
    expect(written.wellness[0]).not.toHaveProperty("atl");
    expect(written.wellness[0]).not.toHaveProperty("ctlLoad");
    expect(written.wellness[0]).not.toHaveProperty("atlLoad");
    expect(written.wellness[0]).not.toHaveProperty("rampRate");
    // Non-TP field rides through; YYYY-MM-DD id preserved.
    expect(written.wellness[0].weight).toBe(73.4);
    expect(written.wellness[0].id).toBe("2026-05-11");
  });

  it("renames TP activity fields to fitnessAtEnd/fatigueAtEnd", async () => {
    const { inputDir, outputDir } = makeTmpDirs();
    const inputPath = join(inputDir, "raw.json");
    writeFileSync(
      inputPath,
      JSON.stringify({
        activities: [
          {
            id: "i12345",
            icu_ctl: 50.5,
            icu_atl: 38.2,
            start_date_local: "2026-05-11T08:00:00",
          },
        ],
      }),
    );

    const exit = await main([inputPath, "rename-activity", "--force"], {
      outputRoot: outputDir,
    });

    expect(exit).toBe(0);
    const written = JSON.parse(
      readFileSync(join(outputDir, "rename-activity.json"), "utf-8"),
    );
    expect(written.activities[0].fitnessAtEnd).toBe(50.5);
    expect(written.activities[0].fatigueAtEnd).toBe(38.2);
    expect(written.activities[0]).not.toHaveProperty("icu_ctl");
    expect(written.activities[0]).not.toHaveProperty("icu_atl");
    // Non-TP fields ride through; account-linking id is redacted.
    expect(written.activities[0].start_date_local).toBe("2026-05-11T08:00:00");
    expect(written.activities[0].id).toBe(12345);
  });

  it("CLI output never contains a TP-named key on any wellness or activity row", async () => {
    const { inputDir, outputDir } = makeTmpDirs();
    const inputPath = join(inputDir, "raw.json");
    writeFileSync(
      inputPath,
      JSON.stringify({
        activities: [
          { id: "i1", icu_ctl: 50, icu_atl: 38, start_date_local: "2026-05-11" },
          { id: "i2", icu_ctl: 51, start_date_local: "2026-05-10" },
        ],
        wellness: [
          {
            id: "2026-05-11",
            ctl: 50,
            atl: 38,
            ctlLoad: 12,
            atlLoad: 18,
            rampRate: 4.5,
          },
          { id: "2026-05-12", ctl: 51, atl: 39 },
        ],
      }),
    );

    const exit = await main([inputPath, "no-tp-keys", "--force"], {
      outputRoot: outputDir,
    });

    expect(exit).toBe(0);
    const written = JSON.parse(
      readFileSync(join(outputDir, "no-tp-keys.json"), "utf-8"),
    );
    for (const row of written.activities) {
      for (const banned of TP_DENYLIST_FIELDS) {
        expect(row).not.toHaveProperty(banned);
      }
    }
    for (const row of written.wellness) {
      for (const banned of TP_DENYLIST_FIELDS) {
        expect(row).not.toHaveProperty(banned);
      }
    }
  });

  it("CLI fails with a non-zero exit and an index-form path when a nested TP key survives rename", async () => {
    const { inputDir, outputDir } = makeTmpDirs();
    const inputPath = join(inputDir, "raw.json");
    // Simulates the "intervals.icu adds nested TP aggregates" failure mode
    // the rename layer doesn't reach (it only renames top-level row fields).
    // Defense-in-depth: assertNoTpKeysRemain catches it before sanitize.
    writeFileSync(
      inputPath,
      JSON.stringify({
        activities: [
          { id: "i9876543", start_date_local: "2026-05-11T08:00:00" },
        ],
        wellness: [
          { id: "2026-05-11", weeklyAggregates: { ctl: 50 } },
        ],
      }),
    );
    const errs: string[] = [];

    const exit = await main([inputPath, "nested-tp", "--force"], {
      outputRoot: outputDir,
      err: (m) => errs.push(m),
    });

    expect(exit).not.toBe(0);
    const errMsg = errs.join("\n");
    expect(errMsg).toMatch(/\[0\]\.weeklyAggregates\.ctl/);
    // Walker uses [<index>] form only — activity row id "i9876543" never
    // leaks into the error path (operator log forwarding stays safe).
    expect(errMsg).not.toMatch(/i\d+/);
  });

  it("CLI emits aggregate-warn for non-number TP values", async () => {
    const { inputDir, outputDir } = makeTmpDirs();
    const inputPath = join(inputDir, "raw.json");
    // ctl as a string is a real-world failure mode (intervals.icu API hiccup
    // or upstream lib drift); the operator should see it surface aggregated.
    writeFileSync(
      inputPath,
      JSON.stringify({
        wellness: [
          { id: "2026-05-11", ctl: "not a number", atl: 38 },
          { id: "2026-05-10", ctl: "also bad" },
        ],
      }),
    );
    const errs: string[] = [];

    const exit = await main([inputPath, "stringy-ctl", "--force"], {
      outputRoot: outputDir,
      err: (m) => errs.push(m),
    });

    expect(exit).toBe(0);
    expect(errs.join("\n")).toMatch(
      /Skipped non-number TP values during rename: ctl \(×2 in wellness\)/,
    );
    const written = JSON.parse(
      readFileSync(join(outputDir, "stringy-ctl.json"), "utf-8"),
    );
    // String-typed ctl was dropped, no fitness emitted.
    expect(written.wellness[0]).not.toHaveProperty("fitness");
    expect(written.wellness[1]).not.toHaveProperty("fitness");
    // Numeric atl was still renamed to fatigue.
    expect(written.wellness[0].fatigue).toBe(38);
  });
});
