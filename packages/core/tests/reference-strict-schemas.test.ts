import { describe, it, expect } from "vitest";
import { z } from "zod";

import * as schemasBarrel from "../src/reference/schemas/index.js";

/**
 * Walks every export of the Reference schemas barrel and asserts each Zod
 * object schema declares `.strict()`. This catches the most common Reference
 * regression — adding a new cache shape without `.strict()`, which makes
 * intervals.icu API drift land silently in our cache.
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
  const exportedSchemas: Array<readonly [string, z.ZodObject<z.ZodRawShape>]> = [];
  for (const [exportName, value] of Object.entries(schemasBarrel)) {
    if (isZodObject(value)) {
      exportedSchemas.push([exportName, value]);
    }
  }

  it("schemas barrel exports at least one Zod object schema", () => {
    // If this fails, F3's schemas barrel forgot to re-export. This is a
    // canary against accidentally emptying the barrel during refactors.
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
