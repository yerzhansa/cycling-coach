// Privacy-denylist transform for fixture JSON. Redacts identifiers, emails,
// free-text PII, GPS coordinates, and TP-trademark-named keys. Preserves all
// numeric signal verbatim — metric tests rely on the realistic distribution
// of weights/HR/power/load. No date jitter (destroys temporal training
// structure). No weight rounding (0.1 kg precision is meaningful test signal).
//
// The seed option is reserved for future per-row id rewriting (e.g.,
// preserving referential integrity between paired_event_id and event ids);
// current rules are constant-replacement so the seed is unused today.

import { TP_DENYLIST_FIELDS } from "../../src/reference/trademark-policy.js";

const ID_KEYS = new Set(["id", "athlete_id"]);
const FREE_TEXT_KEYS = new Set(["name", "description", "notes", "nickname", "bio"]);
const GPS_KEYS = new Set(["start_latlng", "end_latlng"]);
// Structural `id` patterns that ride through redaction unmodified:
//   - YYYY-MM-DD wellness date
//   - Short uppercase-prefixed label (zone bins like "Z1"/"Z10"/"SS"/"WORK")
// Activity ids ("i146622609" or 17654321) and athlete ids are lowercase-
// or numeric-prefixed and longer than 4 chars, so they fall through to
// the redact branch.
const PRESERVED_ID_RE = /^(?:\d{4}-\d{2}-\d{2}|[A-Z][A-Za-z0-9]{0,3})$/;
const TP_KEYS = new Set<string>(TP_DENYLIST_FIELDS);
const EMAIL_RE = /.+@.+\..+/;

// Vendor-correlation strings that aren't IDs but still re-identify the
// operator (model name, intervals.icu group handle, app name, timezone
// — geolocation hint). Mocked with stable sentinels that preserve type so
// test consumers reading these fields see the right *shape* without the
// real value. `timezone: "UTC"` is the safest non-revealing default;
// `group: "00000000"` matches the 8-char hex-fragment intervals.icu emits.
const VENDOR_STRING_MOCK: Record<string, string> = {
  device_name: "sanitized-device",
  group: "00000000",
  oauth_client_name: "sanitized",
  timezone: "UTC",
};

// Specific mock for `icu_athlete_id` — the API form is "i<digits>" and
// preserving that shape lets consuming tests exercise the same parse
// branch a real id would hit. Generic `_id$` redactions below preserve
// type (string → ID_STRING_MOCK, number → ID_NUMERIC_MOCK).
const ICU_ATHLETE_ID_MOCK = "i12345";
const ID_STRING_MOCK = "99999";
const ID_NUMERIC_MOCK = 12345;

function mockSuffixId(key: string, v: unknown): unknown {
  if (v === null || v === undefined) return v;
  if (key === "icu_athlete_id") return ICU_ATHLETE_ID_MOCK;
  if (typeof v === "string") return ID_STRING_MOCK;
  if (typeof v === "number") return ID_NUMERIC_MOCK;
  // Unknown shape (boolean / array / object) — fall back to the numeric
  // sentinel rather than ride through; an ID field shouldn't carry these.
  return ID_NUMERIC_MOCK;
}

export interface SanitizeOptions {
  /** Reserved for deterministic per-row id rewriting (unused today). */
  seed?: string;
}

export interface SanitizeSummary {
  droppedTpKeys: Record<string, number>;
  droppedGpsKeys: Record<string, number>;
  replacedFreeText: Record<string, number>;
  /** Counts every redacted ID — top-level `id`, `athlete_id`, and any
   *  vendor-prefixed key matching `*_id` (icu_athlete_id, strava_id,
   *  external_id, paired_event_id, route_id, oauth_client_id, …). */
  replacedIds: number;
  replacedEmails: number;
  /** Vendor-correlation strings replaced with stable sentinels
   *  (device_name, group, oauth_client_name, timezone). */
  replacedVendor: Record<string, number>;
}

export function sanitizeFixture(input: unknown, _opts?: SanitizeOptions): unknown {
  return walk(input, makeSummary());
}

export function sanitizeFixtureWithSummary(
  input: unknown,
  _opts?: SanitizeOptions,
): { data: unknown; summary: SanitizeSummary } {
  const summary = makeSummary();
  const data = walk(input, summary);
  return { data, summary };
}

function makeSummary(): SanitizeSummary {
  return {
    droppedTpKeys: {},
    droppedGpsKeys: {},
    replacedFreeText: {},
    replacedIds: 0,
    replacedEmails: 0,
    replacedVendor: {},
  };
}

function bump(record: Record<string, number>, key: string): void {
  record[key] = (record[key] ?? 0) + 1;
}

function walk(value: unknown, summary: SanitizeSummary): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => walk(item, summary));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (GPS_KEYS.has(key)) {
        bump(summary.droppedGpsKeys, key);
        continue;
      }
      if (TP_KEYS.has(key)) {
        bump(summary.droppedTpKeys, key);
        continue;
      }
      if (ID_KEYS.has(key)) {
        // `athlete_id` is unconditionally account-linking; redact always.
        // `id` is account-linking by default — activity ids ("i146622609"
        // or 17654321), athlete ids — both forms must redact. Two
        // structural exceptions ride through verbatim because they're
        // load-bearing test signal, not PII:
        //   - wellness `id` is the YYYY-MM-DD date
        //   - zone-bin `id` is "Z1" / "Z2" / etc.
        // Everything else under the `id` key gets redacted.
        if (key === "id" && typeof v === "string" && PRESERVED_ID_RE.test(v)) {
          out[key] = v;
          continue;
        }
        out[key] = ID_NUMERIC_MOCK;
        summary.replacedIds++;
        continue;
      }
      // Vendor-prefixed identifiers — every key ending in `_id` is
      // account-linking (icu_athlete_id, strava_id, external_id,
      // route_id, oauth_client_id, …). Strava IDs in particular are
      // dereferenceable on strava.com and de-anonymize the operator's
      // account if the activity is public. Mock with a stable sentinel
      // that preserves type so test consumers see realistic shape.
      // Keep null/undefined as null/undefined.
      if (key.endsWith("_id")) {
        out[key] = mockSuffixId(key, v);
        if (v !== null && v !== undefined) summary.replacedIds++;
        continue;
      }
      if (key in VENDOR_STRING_MOCK && typeof v === "string") {
        out[key] = VENDOR_STRING_MOCK[key];
        bump(summary.replacedVendor, key);
        continue;
      }
      if (FREE_TEXT_KEYS.has(key) && typeof v === "string") {
        out[key] = "sanitized";
        bump(summary.replacedFreeText, key);
        continue;
      }
      if (typeof v === "string" && EMAIL_RE.test(v)) {
        out[key] = "redacted@example.com";
        summary.replacedEmails++;
        continue;
      }
      out[key] = walk(v, summary);
    }
    return out;
  }
  return value;
}
