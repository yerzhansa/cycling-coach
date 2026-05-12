// Behavioral tests for `tests/helpers/load-fixture.ts`. The loader is the
// substrate every metric test reaches for to read its golden fixture; it
// must throw loudly on parse/IO failure (test bugs, not runtime conditions)
// and resolve names against the `tests/fixtures/` root.

import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { ActivitySchema } from "../src/reference/schemas/inputs.js";
import { TP_DENYLIST_FIELDS } from "../src/reference/trademark-policy.js";
import { GoldenFixtureSchema, loadFixture } from "./helpers/load-fixture.js";
import { ALLOWED_FIXTURE_KEYS } from "../../../tools/sanitize-fixture-transform.js";

const tmpRoot = mkdtempSync(join(tmpdir(), "reference-load-fixture-"));
afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("loadFixture", () => {
  it("loads a JSON fixture and parses it through the given schema", () => {
    writeFileSync(join(tmpRoot, "tracer.json"), JSON.stringify({ x: 42, y: "hi" }));
    const Schema = z.object({ x: z.number(), y: z.string() }).strict();

    const result = loadFixture("tracer", Schema, { rootDir: tmpRoot });

    expect(result).toEqual({ x: 42, y: "hi" });
  });

  it("throws ENOENT on a missing fixture", () => {
    const Schema = z.object({}).strict();
    expect(() => loadFixture("does-not-exist", Schema, { rootDir: tmpRoot })).toThrow(/ENOENT/);
  });

  it("throws on invalid JSON", () => {
    writeFileSync(join(tmpRoot, "broken.json"), "{ this is not json");
    const Schema = z.object({}).strict();
    expect(() => loadFixture("broken", Schema, { rootDir: tmpRoot })).toThrow();
  });

  it("throws on Zod parse failure with the fixture path AND issue details in the message", () => {
    writeFileSync(join(tmpRoot, "wrong-shape.json"), JSON.stringify({ x: "not a number" }));
    const Schema = z.object({ x: z.number() }).strict();

    let caught: Error | undefined;
    try {
      loadFixture("wrong-shape", Schema, { rootDir: tmpRoot });
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).toBeDefined();
    expect(caught!.message).toMatch(/wrong-shape\.json/);
    expect(caught!.message).toMatch(/invalid_type|expected number/i);
  });
});

describe("loadFixture against committed golden fixtures", () => {
  it("loads golden/zero-activities and exposes empty activities + ftp_history", () => {
    const data = loadFixture("golden/zero-activities", GoldenFixtureSchema);

    expect(data.activities).toEqual([]);
    expect(data.ftp_history).toEqual([]);
    expect(data.wellness.length).toBeGreaterThanOrEqual(1);
  });

  it("loads golden/post-break-resume — 21 days of wellness then a single ride 21 days after the first wellness day", () => {
    const data = loadFixture("golden/post-break-resume", GoldenFixtureSchema);

    expect(data.activities.length).toBe(1);
    expect(data.wellness.length).toBeGreaterThanOrEqual(21);

    const firstWellnessDate = new Date(data.wellness[0].id + "T00:00:00Z");
    const rideDate = new Date(data.activities[0].start_date_local);
    const dayDiff = Math.floor(
      (rideDate.getTime() - firstWellnessDate.getTime()) / (24 * 60 * 60 * 1000),
    );
    expect(dayDiff).toBe(21);
  });

  it("loads golden/realistic-athlete — 12 weeks of operator-sanitized real intervals.icu data parses through GoldenFixtureSchema", () => {
    const data = loadFixture("golden/realistic-athlete", GoldenFixtureSchema);

    // Lower bounds — the fixture is regenerated periodically from a real
    // 12-week pull, so exact counts drift. The asserts confirm the fixture
    // is non-trivial in all three arrays without pinning to today's snapshot.
    expect(data.activities.length).toBeGreaterThanOrEqual(20);
    expect(data.wellness.length).toBeGreaterThanOrEqual(60);
    expect(data.ftp_history.length).toBeGreaterThanOrEqual(1);

    // Sanitization invariants metric tests will lean on: every activity id
    // is the redacted sentinel (no real account-linking ids leak through
    // the privacy boundary).
    for (const act of data.activities) {
      expect(act.id).toBe(12345);
    }
    // Wellness `id` is the YYYY-MM-DD date — structural, preserved.
    for (const day of data.wellness) {
      expect(typeof day.id).toBe("string");
      expect(day.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("realistic-athlete — at least one wellness row has a numeric fitness value", () => {
    const data = loadFixture("golden/realistic-athlete", GoldenFixtureSchema);
    const withFitness = data.wellness.filter(
      (d) => typeof d.fitness === "number" && Number.isFinite(d.fitness),
    );
    expect(withFitness.length).toBeGreaterThan(0);
  });

  it("realistic-athlete — at least one activity row has a numeric fitnessAtEnd value", () => {
    const data = loadFixture("golden/realistic-athlete", GoldenFixtureSchema);
    const withFitnessAtEnd = data.activities.filter(
      (a) => typeof a.fitnessAtEnd === "number" && Number.isFinite(a.fitnessAtEnd),
    );
    expect(withFitnessAtEnd.length).toBeGreaterThan(0);
  });

  it("realistic-athlete — no wellness row retains any TP-named key", () => {
    const data = loadFixture("golden/realistic-athlete", GoldenFixtureSchema);
    for (const day of data.wellness) {
      for (const banned of TP_DENYLIST_FIELDS) {
        expect(day as Record<string, unknown>).not.toHaveProperty(banned);
      }
    }
  });

  it("realistic-athlete — no activity row retains either icu_ctl or icu_atl", () => {
    const data = loadFixture("golden/realistic-athlete", GoldenFixtureSchema);
    for (const act of data.activities) {
      expect(act as Record<string, unknown>).not.toHaveProperty("icu_ctl");
      expect(act as Record<string, unknown>).not.toHaveProperty("icu_atl");
    }
  });

  // ─── PII regression scanner — single allowlist assertion ─────────────
  //
  // Walk the committed fixture and assert every key appears in
  // ALLOWED_FIXTURE_KEYS (the union of schema-derived names + the small
  // EXTRA_ALLOW list in tests/helpers/sanitize-fixture.ts).
  //
  // Why one assertion instead of a growing list of negative checks: the
  // prior denylist-style scanner only caught fields it explicitly named
  // (`*_id`, `device_name`, `group`, `timezone`, `oauth_client_name`). It
  // missed power_meter_serial, power_meter, source, skyline_chart_bytes,
  // and any future operator-identifying field intervals.icu adds. The
  // allowlist assertion is structural: a new leak class can't sneak past
  // it because the default action is fail.
  //
  // No byte-level needle scan: encoding the operator's known-leak strings
  // here would re-introduce the exact PII this fixture-regen was meant to
  // remove. The structural assertion covers the surface without naming
  // leaked values.
  describe("realistic-athlete — PII regression scanner (allowlist)", () => {
    it("every key in the committed fixture appears in ALLOWED_FIXTURE_KEYS", () => {
      const data = loadFixture("golden/realistic-athlete", GoldenFixtureSchema);
      const offending: string[] = [];
      const recurse = (v: unknown, path: string): void => {
        if (Array.isArray(v)) {
          v.forEach((item, i) => recurse(item, `${path}[${i}]`));
          return;
        }
        if (v !== null && typeof v === "object") {
          for (const [key, child] of Object.entries(v as Record<string, unknown>)) {
            const childPath = path === "" ? key : `${path}.${key}`;
            if (!ALLOWED_FIXTURE_KEYS.has(key)) {
              offending.push(`${childPath} (key not in allowlist)`);
            }
            recurse(child, childPath);
          }
        }
      };
      recurse(data, "");
      expect(
        offending,
        `Fixture carries keys outside ALLOWED_FIXTURE_KEYS — likely PII leak.\n` +
          `Either regenerate the fixture under the current sanitizer or, if the key is genuinely load-bearing test signal,\n` +
          `add it to EXTRA_ALLOW in tests/helpers/sanitize-fixture.ts with a one-line justification.\n` +
          `Offending paths:\n  ${offending.slice(0, 20).join("\n  ")}${offending.length > 20 ? `\n  …+${offending.length - 20} more` : ""}`,
      ).toEqual([]);
    });

    it("every `*_id` value is either null/undefined or the redacted-id mock (12345 / structural date / Z-label)", () => {
      // Secondary check: even allowlisted *_id keys (only paired_event_id
      // under current schemas) must hold the mock sentinel, never a
      // real-shaped value. Future schema additions that introduce another
      // *_id key would also be caught here.
      const data = loadFixture("golden/realistic-athlete", GoldenFixtureSchema);
      const allowedIdValues = new Set<unknown>([12345]);
      const recurse = (v: unknown): void => {
        if (Array.isArray(v)) {
          v.forEach(recurse);
          return;
        }
        if (v !== null && typeof v === "object") {
          for (const [key, child] of Object.entries(v as Record<string, unknown>)) {
            if (key.endsWith("_id") && child !== null && child !== undefined) {
              expect(
                allowedIdValues.has(child),
                `${key}=${JSON.stringify(child)} is not the mock sentinel — possible PII leak.`,
              ).toBe(true);
            }
            recurse(child);
          }
        }
      };
      recurse(data);
    });
  });

  it("loads synthetic/has-intervals-placeholder — ride whose icu_intervals is a single RECOVERY placeholder (section-11 v3.106 regression case)", () => {
    const data = loadFixture("synthetic/has-intervals-placeholder", ActivitySchema);

    expect(data.icu_intervals).toBeDefined();
    expect(data.icu_intervals).toHaveLength(1);
    expect(data.icu_intervals![0].type).toBe("RECOVERY");

    // The _comment field rides through ActivitySchema's z.looseObject index
    // signature (no schema-level support for JSON comments). Asserting it
    // landed on `data` confirms the regression-case rationale travels with
    // the fixture for any future maintainer who finds it via grep.
    expect((data as Record<string, unknown>)._comment).toEqual(expect.stringMatching(/RECOVERY|placeholder|v3\.106/i));
  });
});
