// Different from `safeReadJson` (production graceful-null path): a missing
// or invalid fixture is a test bug, not a runtime condition. Throw loudly
// with the fixture path AND the Zod issue tree so the failure points at
// the bug.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z, type ZodTypeAny } from "zod";

import {
  ActivitySchema,
  FtpHistoryPointSchema,
  WellnessDaySchema,
} from "../../src/reference/schemas/inputs.js";

/** Aggregate envelope for committed golden fixtures. Top-level `.strict()`
 *  ensures the envelope has exactly the 3 named arrays — no rogue keys
 *  masquerading as fixture data. Per-row schemas are `z.looseObject()` so
 *  real intervals.icu shape rides through without losing TP-trademark fields. */
export const GoldenFixtureSchema = z
  .object({
    activities: z.array(ActivitySchema),
    wellness: z.array(WellnessDaySchema),
    ftp_history: z.array(FtpHistoryPointSchema),
  })
  .strict();
export type GoldenFixture = z.infer<typeof GoldenFixtureSchema>;

const DEFAULT_FIXTURES_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
);

export interface LoadFixtureOptions {
  /** Override the fixture-root directory. Tests use tmpdir to stay
   *  self-contained; production callers omit it. */
  rootDir?: string;
}

export function loadFixture<S extends ZodTypeAny>(
  name: string,
  schema: S,
  opts?: LoadFixtureOptions,
): z.infer<S> {
  const root = opts?.rootDir ?? DEFAULT_FIXTURES_ROOT;
  const path = resolve(root, `${name}.json`);
  const raw = readFileSync(path, "utf-8");
  const parsed = JSON.parse(raw);
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `loadFixture: ${path} failed schema parse:\n${result.error.message}`,
    );
  }
  return result.data;
}
