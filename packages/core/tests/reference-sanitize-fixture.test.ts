// Behavioral tests for `tests/helpers/sanitize-fixture.ts` — a privacy-
// denylist transform. Redact fields that could re-identify the operator,
// drop GPS + TP-trademark keys, preserve numeric signal verbatim. No
// projection. No rounding. No date jitter.

import { describe, expect, it } from "vitest";

import { sanitizeFixture, sanitizeFixtureWithSummary } from "./helpers/sanitize-fixture.js";

describe("sanitizeFixture", () => {
  it("replaces top-level id and athlete_id with 12345", () => {
    expect(sanitizeFixture({ id: 9876543, athlete_id: "operator-uuid-xyz" })).toEqual({
      id: 12345,
      athlete_id: 12345,
    });
  });

  it("replaces email-shaped strings with redacted@example.com", () => {
    expect(
      sanitizeFixture({ contact: "operator@example.com", deeply: { nested: "x@y.z" } }),
    ).toEqual({
      contact: "redacted@example.com",
      deeply: { nested: "redacted@example.com" },
    });
  });

  it("replaces free-text PII fields with 'sanitized' (name, description, notes, nickname, bio)", () => {
    expect(
      sanitizeFixture({
        name: "Yerzhan's Friday ride near home",
        description: "felt great, mile 12 on Cherry Lane was tough",
        notes: "left calf twinge",
        nickname: "operator-handle",
        bio: "long bio with location hints",
        // Same keys nested in an object
        athlete: { name: "Operator Real Name", bio: "..." },
      }),
    ).toEqual({
      name: "sanitized",
      description: "sanitized",
      notes: "sanitized",
      nickname: "sanitized",
      bio: "sanitized",
      athlete: { name: "sanitized", bio: "sanitized" },
    });
  });

  it("drops GPS coordinate keys (start_latlng, end_latlng) anywhere in the tree", () => {
    expect(
      sanitizeFixture({
        keep: 1,
        start_latlng: [37.7749, -122.4194],
        end_latlng: [37.7849, -122.4094],
        nested: { keep_too: 2, start_latlng: [40, -74] },
      }),
    ).toEqual({
      keep: 1,
      nested: { keep_too: 2 },
    });
  });

  it("drops TP-trademark-named keys (cosmetic JSON hygiene; type already excludes them)", () => {
    const dirty = {
      ftp: 285,
      ctl: 52.1,
      atl: 38.4,
      ctlLoad: 51.9,
      atlLoad: 38.1,
      rampRate: 4.7,
      icu_atl: 38.4,
      icu_ctl: 52.1,
      tsb: 13.7,
      tss: 142,
      if: 0.82,
      activities: [{ id: 1, ctl: 50, kj: 1180 }],
    };

    expect(sanitizeFixture(dirty)).toEqual({
      ftp: 285,
      activities: [{ id: 12345, kj: 1180 }],
    });
  });

  it("preserves structural `id` patterns (ISO date, zone label) but redacts identifier-shaped `id` (numeric or string-prefixed) and any `athlete_id`", () => {
    const data = {
      // Wellness `id` is the YYYY-MM-DD date — structural, not PII.
      wellness: [
        { id: "2026-04-15", weight: 73.4 },
        { id: "2026-04-16", weight: 73.5 },
      ],
      activities: [
        {
          // Numeric activity id — account-linking, must redact.
          id: 9876,
          average_watts: 200,
          // Zone-bin `id` "Z1"/"Z2" — structural label, preserve.
          icu_zone_times: [
            { id: "Z1", secs: 600 },
            { id: "Z2", secs: 1800 },
            // intervals.icu also emits named cross-zone bins like Sweet
            // Spot ("SS") — preserve any short uppercase-prefixed label.
            { id: "SS", secs: 780 },
          ],
        },
        {
          // String activity id like "i146622609" — account-linking, redact.
          id: "i146622609",
          average_watts: 220,
        },
      ],
      // athlete_id always redacts, even when string-typed (UUID-shaped).
      athlete_id: "operator-uuid-xyz",
    };
    expect(sanitizeFixture(data)).toEqual({
      wellness: [
        { id: "2026-04-15", weight: 73.4 },
        { id: "2026-04-16", weight: 73.5 },
      ],
      activities: [
        {
          id: 12345,
          average_watts: 200,
          icu_zone_times: [
            { id: "Z1", secs: 600 },
            { id: "Z2", secs: 1800 },
            { id: "SS", secs: 780 },
          ],
        },
        {
          id: 12345,
          average_watts: 220,
        },
      ],
      athlete_id: 12345,
    });
  });

  it("preserves ISO date strings verbatim (no jitter — destroys training-pattern signal)", () => {
    const data = {
      start_date_local: "2026-04-15T07:30:00",
      weekStartDate: "2026-04-13",
      activity: { start_date_local: "2026-04-14T18:00:00" },
    };
    expect(sanitizeFixture(data)).toEqual(data);
  });

  it("preserves numeric metrics at full precision (no rounding)", () => {
    const data = {
      weight: 73.42, // 0.1kg precision is meaningful test signal
      icu_intensity: 0.823456,
      ftp: 285,
      icu_training_load: 142.7,
      decoupling: 4.21,
      bodyFat: 14.6,
      activities: [{ id: 1, average_watts: 218.4, hrv: 84 }],
    };

    const sanitized = sanitizeFixture(data) as typeof data;
    expect(sanitized.weight).toBe(73.42);
    expect(sanitized.icu_intensity).toBe(0.823456);
    expect(sanitized.ftp).toBe(285);
    expect(sanitized.icu_training_load).toBe(142.7);
    expect(sanitized.decoupling).toBe(4.21);
    expect(sanitized.bodyFat).toBe(14.6);
    expect(sanitized.activities[0].average_watts).toBe(218.4);
    expect(sanitized.activities[0].hrv).toBe(84);
  });

  it("returns empty object for empty input without crashing", () => {
    expect(sanitizeFixture({})).toEqual({});
  });

  it("mocks every vendor-prefixed *_id key, preserving the value type", () => {
    // The leak audit on the operator-generated fixture revealed vendor-id
    // surfaces (icu_athlete_id, strava_id, external_id, route_id, …)
    // surviving sanitize because the old rule only matched `id` and
    // `athlete_id`. The widened rule catches any `*_id` suffix; type is
    // preserved (string → "99999", number → 12345) so test consumers see
    // realistic shape. Test inputs below use synthetic placeholder values
    // — never the operator's real ids — so this file itself can't carry
    // PII the way the fixture did pre-fix.
    expect(
      sanitizeFixture({
        icu_athlete_id: "iEXAMPLE",
        strava_id: "STRAVA-PLACEHOLDER",
        external_id: "GARMIN-PLACEHOLDER",
        route_id: "ROUTE-PLACEHOLDER",
        icu_chat_id: null,
        oauth_client_id: null,
        paired_event_id: 11,
        activities: [
          {
            strava_id: "STRAVA-PLACEHOLDER-2",
            external_id: null,
            paired_event_id: null,
          },
        ],
      }),
    ).toEqual({
      icu_athlete_id: "i12345",
      strava_id: "99999",
      external_id: "99999",
      route_id: "99999",
      icu_chat_id: null,
      oauth_client_id: null,
      paired_event_id: 12345,
      activities: [
        { strava_id: "99999", external_id: null, paired_event_id: null },
      ],
    });
  });

  it("mocks vendor-correlation strings (device_name, group, oauth_client_name, timezone) with stable sentinels", () => {
    // Synthetic placeholders only — no real device names, no real
    // intervals.icu group fragments, no operator's actual timezone.
    expect(
      sanitizeFixture({
        device_name: "Test Brand Test Model",
        group: "testgrp1",
        oauth_client_name: "Test OAuth App",
        timezone: "Test/Zone",
        activities: [
          { device_name: "Other Test Device", group: "testgrp2" },
        ],
      }),
    ).toEqual({
      device_name: "sanitized-device",
      group: "00000000",
      oauth_client_name: "sanitized",
      timezone: "UTC",
      activities: [
        { device_name: "sanitized-device", group: "00000000" },
      ],
    });
  });

  it("preserves null/undefined values on *_id keys (doesn't fabricate fake IDs out of thin air)", () => {
    expect(sanitizeFixture({ strava_id: null, route_id: null })).toEqual({
      strava_id: null,
      route_id: null,
    });
  });

  it("preserves zone-bin id label ('Z1', 'SS') under the new rules", () => {
    // Zone bins use `id` not `_id`-suffix, so the existing structural-id
    // preservation still applies. Regression guard: don't break this.
    expect(
      sanitizeFixture({
        icu_zone_times: [
          { id: "Z1", secs: 600 },
          { id: "SS", secs: 780 },
        ],
      }),
    ).toEqual({
      icu_zone_times: [
        { id: "Z1", secs: 600 },
        { id: "SS", secs: 780 },
      ],
    });
  });

  it("preserves null and primitive top-level values without crashing", () => {
    expect(sanitizeFixture(null)).toBe(null);
    expect(sanitizeFixture(42)).toBe(42);
    expect(sanitizeFixture("plain string")).toBe("plain string");
    expect(sanitizeFixture([])).toEqual([]);
  });

  it("is deterministic — same input twice produces byte-identical output", () => {
    const dirty = {
      id: 9876543,
      ctl: 52.1,
      activities: [
        {
          id: 1,
          name: "ride",
          start_latlng: [37, -122],
          icu_atl: 38,
          contact: "x@y.z",
        },
      ],
    };

    const a = JSON.stringify(sanitizeFixture(dirty));
    const b = JSON.stringify(sanitizeFixture(dirty));
    expect(a).toBe(b);
  });
});

describe("sanitizeFixtureWithSummary", () => {
  it("returns the sanitized data plus a count of dropped TP-trademark + GPS keys and replaced fields", () => {
    const dirty = {
      id: 11,
      ctl: 50,
      atl: 38,
      tsb: 12,
      activities: [
        {
          id: 1,
          ctl: 51,
          start_latlng: [37, -122],
          name: "morning ride",
          contact: "x@y.z",
        },
        {
          id: 2,
          atl: 37,
          end_latlng: [38, -123],
          name: "evening ride",
        },
      ],
    };

    const { data, summary } = sanitizeFixtureWithSummary(dirty);

    // The data is identical to what sanitizeFixture would have produced.
    expect(data).toEqual(sanitizeFixture(dirty));

    // Counts: ctl appears 2x (top + activities[0]), atl appears 2x, tsb 1x.
    expect(summary.droppedTpKeys.ctl).toBe(2);
    expect(summary.droppedTpKeys.atl).toBe(2);
    expect(summary.droppedTpKeys.tsb).toBe(1);
    // GPS: start_latlng 1x, end_latlng 1x.
    expect(summary.droppedGpsKeys.start_latlng).toBe(1);
    expect(summary.droppedGpsKeys.end_latlng).toBe(1);
    // Replaced: 3 ids → 12345, 2 free-text names → "sanitized", 1 email.
    expect(summary.replacedIds).toBe(3);
    expect(summary.replacedFreeText.name).toBe(2);
    expect(summary.replacedEmails).toBe(1);
    // No vendor-correlation strings in this input.
    expect(summary.replacedVendor).toEqual({});
  });

  it("counts vendor-prefixed *_id redactions in replacedIds and vendor-correlation strings in replacedVendor", () => {
    // Synthetic placeholders only — never the operator's real ids.
    const dirty = {
      icu_athlete_id: "iEXAMPLE",
      strava_id: "STRAVA-PLACEHOLDER-A",
      device_name: "Test Brand A",
      group: "testgrpA",
      activities: [
        {
          strava_id: "STRAVA-PLACEHOLDER-B",
          device_name: "Test Brand B",
          paired_event_id: 99,
        },
        { strava_id: null, device_name: "Test Brand A" },
      ],
    };

    const { summary } = sanitizeFixtureWithSummary(dirty);

    // 1 (icu_athlete_id) + 1 (top strava_id) + 1 (acts[0].strava_id) + 1 (paired_event_id) = 4.
    // acts[1].strava_id is null and doesn't increment.
    expect(summary.replacedIds).toBe(4);
    expect(summary.replacedVendor.device_name).toBe(3);
    expect(summary.replacedVendor.group).toBe(1);
  });
});
