import { z } from "zod";

// Bump this only when THIS file's shape changes — never in lockstep with
// sibling schemas. See CONTRIBUTING.md "Reference schema-version policy."
export const LATEST_SCHEMA_VERSION = "1";

export const LatestJsonSchema = z
  .object({
    metadata: z
      .object({
        schema_version: z.string(),
        last_updated: z.string(),
        freshness: z.enum(["fresh", "flag", "stale", "critical"]),
      })
      .strict(),
    athlete_profile: z.unknown(),
    current_status: z.unknown(),
    derived_metrics: z.unknown(),
    derived_metrics_meta: z
      .object({
        sportFamily: z.string(),
        basis: z.enum(["power", "pace", "hr"]),
        anchorType: z.enum(["critical-speed", "ftp"]),
      })
      .strict()
      .optional(),
    recent_activities: z.array(z.unknown()),
    planned_workouts: z.array(z.unknown()),
    wellness_data: z.unknown(),
  })
  .strict();

export type LatestJson = z.infer<typeof LatestJsonSchema>;
