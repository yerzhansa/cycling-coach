import { describe, it, expect } from "vitest";
import { z } from "zod";

import * as cacheBarrel from "../src/reference/schemas/cache-index.js";
import * as metricsBarrel from "../src/reference/metrics/index.js";

/**
 * Walks every export of the Reference cache + metrics barrels and asserts
 * each Zod object schema declares `.strict()`. This catches the most common
 * Reference regression — adding a new cache or metric shape without
 * `.strict()`, which makes intervals.icu API drift land silently in our
 * cache or metric authors silently widen the metric contract.
 *
 * The input-schema barrel (inputs.ts) is excluded by design: input schemas
 * use `z.looseObject()` to project the upstream API; their drift-gate is
 * the trademark denylist test (reference-input-schemas-no-tp.test.ts), not
 * the strict gate.
 *
 * Asserted via behavior, not Zod internals: for each ZodObject we extract,
 * we feed it an input shaped `{ __forbidden_extra__: <value> }` and verify
 * Zod rejects it with an `unrecognized_keys` error. A non-strict (default
 * "strip") object would silently drop the extra field and produce a different
 * (or no) error.
 *
 * Test stays valid across Zod versions because it tests behavior, not the
 * schema's `.def` shape.
 */

function isZodObject(value: unknown): value is z.ZodObject<z.ZodRawShape> {
  return value instanceof z.ZodObject;
}

function declaresStrict(schema: z.ZodObject<z.ZodRawShape>): {
  strict: boolean;
  reason?: string;
} {
  const probe = schema.safeParse({ __reference_strict_canary__: "x" });
  if (probe.success) {
    return {
      strict: false,
      reason: "schema accepted an unknown key (`__reference_strict_canary__`)",
    };
  }
  const flagsExtraKey = probe.error.issues.some((i) => i.code === "unrecognized_keys");
  return flagsExtraKey
    ? { strict: true }
    : {
        strict: false,
        reason:
          "schema rejected the canary input but NOT via `unrecognized_keys` — " +
          "indicates a non-strict object that happened to reject due to other " +
          "constraints. Add `.strict()` to enforce the drift gate.",
      };
}

describe("Reference Zod schemas — every object schema declares .strict()", () => {
  const allBarrels = [
    ["cache", cacheBarrel],
    ["metrics", metricsBarrel],
  ] as const;

  const exportedSchemas: Array<readonly [string, z.ZodObject<z.ZodRawShape>]> = [];
  for (const [barrelName, barrel] of allBarrels) {
    for (const [exportName, value] of Object.entries(barrel)) {
      if (isZodObject(value)) {
        exportedSchemas.push([`${barrelName}/${exportName}`, value]);
      }
    }
  }

  it("at least one Zod object schema across cache + metrics barrels", () => {
    // If this fails, the cache barrel emptied or metric schemas are not
    // surfaced through metrics/index.ts (re-export discipline broke).
    expect(exportedSchemas.length).toBeGreaterThan(0);
  });

  it.each(exportedSchemas)("%s declares .strict()", (name, schema) => {
    const result = declaresStrict(schema);
    expect(
      result.strict,
      `Schema ${name} is not strict: ${result.reason ?? "unknown reason"}`,
    ).toBe(true);
  });
});
