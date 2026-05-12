// Trademark-wall mechanical assertion.
//
// The trademark linter at `tools/check-trademarks.ts` scans string literals
// and comments — NOT Zod field names. Without this test, "don't name fields
// with TP-trademark tokens" is enforced only by reviewer attention. Six
// months from now, a contributor reads `icu_atl` in the intervals.icu API
// and adds it to a schema; TypeScript doesn't care; the linter passes; the
// trademark wall is breached silently.
//
// This test asserts at the *shape* level (not the inferred-type level —
// `z.looseObject` adds a `[key: string]: unknown` index signature that
// would make any field name type-check as `unknown`). Schema shape is the
// load-bearing trademark wall mechanism.
//
// Evidence + policy: docs/knowledge/research/trademark-tp-terms.md.

import { describe, it, expect } from "vitest";

import {
  ActivitySchema,
  WellnessDaySchema,
  WeeklyRollupSchema,
  IcuIntervalRepSchema,
  ZoneTimesSchema,
  PlannedEventSchema,
  FtpHistoryPointSchema,
} from "../src/reference/schemas/inputs.js";
import { TP_DENYLIST_FIELDS } from "../src/reference/trademark-policy.js";

const TP_BANNED_KEYS = TP_DENYLIST_FIELDS;

const SCHEMAS_TO_CHECK = [
  ["ActivitySchema", ActivitySchema],
  ["WellnessDaySchema", WellnessDaySchema],
  ["WeeklyRollupSchema", WeeklyRollupSchema],
  ["IcuIntervalRepSchema", IcuIntervalRepSchema],
  ["ZoneTimesSchema", ZoneTimesSchema],
  ["PlannedEventSchema", PlannedEventSchema],
  ["FtpHistoryPointSchema", FtpHistoryPointSchema],
] as const;

describe("Reference input schemas — no TP-trademark-named fields", () => {
  it.each(SCHEMAS_TO_CHECK)("%s has no banned TP-trademark keys", (name, schema) => {
    const fields = Object.keys(schema.shape);
    for (const banned of TP_BANNED_KEYS) {
      expect(
        fields,
        `${name} has banned TP-trademark key '${banned}' — see docs/knowledge/research/trademark-tp-terms.md`,
      ).not.toContain(banned);
    }
  });
});
