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

  // ─── PII regression scanner ──────────────────────────────────────────
  //
  // Walk the committed fixture and assert that every `*_id` field, plus
  // the vendor-correlation keys, holds the mock sentinel (or null) —
  // never a real-shaped value.
  //
  // Known mock sentinels:
  //   icu_athlete_id → "i12345"            (preserves "i<digits>" form)
  //   <vendor>_id    → "99999" or 12345    (type preserved)
  //   id             → 12345 or structural (date / zone label)
  //   device_name    → "sanitized-device"
  //   group          → "00000000"
  //   oauth_client_name → "sanitized"
  //   timezone       → "UTC"
  describe("realistic-athlete — PII regression scanner", () => {
    type AnyObj = Record<string, unknown>;
    function walkRows(): AnyObj[] {
      const data = loadFixture("golden/realistic-athlete", GoldenFixtureSchema);
      const out: AnyObj[] = [];
      const recurse = (v: unknown): void => {
        if (Array.isArray(v)) v.forEach(recurse);
        else if (v !== null && typeof v === "object") {
          out.push(v as AnyObj);
          for (const child of Object.values(v as AnyObj)) recurse(child);
        }
      };
      recurse(data);
      return out;
    }
    const allowedIdMocks = new Set<unknown>([12345, "99999", "i12345"]);

    it("no `*_id` key holds a real-shaped value — only null, undefined, or the mock sentinels", () => {
      for (const row of walkRows()) {
        for (const [key, v] of Object.entries(row)) {
          if (!key.endsWith("_id")) continue;
          if (v === null || v === undefined) continue;
          expect(
            allowedIdMocks.has(v),
            `${key}=${JSON.stringify(v)} is not a mock sentinel — possible PII leak. Allowed: ${[...allowedIdMocks].join(",")}`,
          ).toBe(true);
        }
      }
    });

    it("no activity carries a real device_name (must be 'sanitized-device' if present)", () => {
      for (const row of walkRows()) {
        if ("device_name" in row && typeof row.device_name === "string") {
          expect(row.device_name).toBe("sanitized-device");
        }
      }
    });

    it("no activity carries a real `group` fragment (must be '00000000' if present)", () => {
      for (const row of walkRows()) {
        if ("group" in row && typeof row.group === "string") {
          expect(row.group).toBe("00000000");
        }
      }
    });

    it("no row carries a real timezone (must be 'UTC' or null if present)", () => {
      for (const row of walkRows()) {
        if ("timezone" in row) {
          const tz = row.timezone;
          if (tz === null) continue;
          expect(tz).toBe("UTC");
        }
      }
    });

    it("no row carries a real oauth_client_name (must be 'sanitized' or null)", () => {
      for (const row of walkRows()) {
        if ("oauth_client_name" in row) {
          const name = row.oauth_client_name;
          if (name === null) continue;
          expect(name).toBe("sanitized");
        }
      }
    });

    // No byte-level needle scan: encoding the operator's known-leak strings
    // here would re-introduce the exact PII this fixture-regen was meant to
    // remove. The structural assertions above (every `*_id` key is a mock
    // sentinel, every device_name is "sanitized-device", every group is
    // "00000000", timezone is "UTC" or null, oauth_client_name is
    // "sanitized" or null) cover the same surface without naming the
    // leaked values. If a future regression surfaces a new leak class,
    // extend the structural scans — never add the leaked plaintext to a
    // checked-in file.
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
