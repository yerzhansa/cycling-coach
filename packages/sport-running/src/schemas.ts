import { z } from "zod";
import { CS_MIN_MPS, CS_MAX_MPS } from "@enduragent/core";

// ============================================================================
// SHARED ENUMS
// ============================================================================

export const experienceLevelSchema = z.enum(["beginner", "intermediate", "advanced", "elite"]);

/** intervals.icu display-preference units this package renders. */
export const paceUnitsSchema = z.enum(["MINS_KM", "MINS_MILE"]);

/** Where the critical-speed anchor came from. `computed` is reserved for the
 *  deferred best-efforts-fit path; this wave ships `platform` + `athlete_manual`. */
export const csSourceSchema = z.enum(["platform", "athlete_manual", "computed"]);

/** Platform-supplied reliability of the anchor; disclosure-only. */
export const csConfidenceSchema = z.enum(["high", "medium", "low"]);

// ============================================================================
// ATHLETE PROFILE SCHEMA
// ============================================================================
// Drives the running profile wizard + validation. The CS anchor is nullable so
// a cold-start athlete (no platform value, no manual entry yet) is representable;
// the CS-source gate + the calculate_zones tool enforce a sane value before zones
// are emitted. Sex is deliberately absent — it is disclosure-only voice, not a
// zone coefficient (see SOUL.md).

export const athleteProfileSchema = z.object({
  experienceLevel: experienceLevelSchema.optional(),
  weightKg: z.number().positive().optional(),
  criticalSpeedMps: z.number().min(CS_MIN_MPS).max(CS_MAX_MPS).nullable().optional(),
  paceUnits: paceUnitsSchema.nullable().optional(),
  csSource: csSourceSchema.nullable().optional(),
  csConfidence: csConfidenceSchema.nullable().optional(),
  lowerFractionOverride: z.number().min(0.78).max(0.88).nullable().optional(),
});

// ============================================================================
// TYPE EXPORTS
// ============================================================================

export type ExperienceLevel = z.infer<typeof experienceLevelSchema>;
export type PaceUnits = z.infer<typeof paceUnitsSchema>;
export type CsSource = z.infer<typeof csSourceSchema>;
export type CsConfidence = z.infer<typeof csConfidenceSchema>;
export type RunningAthleteProfile = z.infer<typeof athleteProfileSchema>;
