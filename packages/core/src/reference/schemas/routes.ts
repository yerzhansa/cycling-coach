// Adapted from CrankAddict/section-11 (MIT, 2026); see NOTICE.md.

import { z } from "zod";

export const ROUTES_SCHEMA_VERSION = "1";

/**
 * `routes.json` — recent route metadata (gradient, surface, climb totals)
 * cached so the curator can surface route-aware coaching context.
 */
export const RoutesJsonSchema = z
  .object({
    metadata: z
      .object({
        schema_version: z.string(),
        last_updated: z.string(),
      })
      .strict(),
    routes: z.array(z.unknown()),
  })
  .strict();

export type RoutesJson = z.infer<typeof RoutesJsonSchema>;
