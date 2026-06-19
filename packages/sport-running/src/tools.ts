import { tool, zodSchema } from "ai";
import { z } from "zod";
import type { MemoryStore } from "@enduragent/core";
import type { IntervalsClient } from "intervals-icu-api";
import {
  calculateRunningZones,
  LOWER_FRACTION_CLAMP,
  CS_SANITY_MPS,
  THRESHOLD_DEFINITION,
  type RunningZoneDisplay,
} from "./zones.js";

/**
 * Pure-Sport running tools per ADR-0004. This wave ships the CS-anchored
 * `calculate_zones` tool only; the intervals.icu workout creator is deferred
 * until a running workout serializer exists (Pure-Core + Core-with-sport-config
 * intervals tools still compose in via `runningSport.tools`).
 */

const RPE_FRAMING =
  "These paces are RPE-checked estimates from a population-mean model, not " +
  "lab-measured thresholds — if pace and effort disagree, trust effort and adjust. " +
  "The single table carries individual and sex-specific spread; CS is a monitoring " +
  "anchor, not a hold-forever pace.";

function clampLowerFraction(requested: number): { value: number; clamped: boolean } {
  const value = Math.min(LOWER_FRACTION_CLAMP.max, Math.max(LOWER_FRACTION_CLAMP.min, requested));
  return { value, clamped: value !== requested };
}

export function createRunningTools(
  _memory: MemoryStore,
  _intervals: IntervalsClient | null,
  _tz: string = "UTC",
) {
  return {
    calculate_zones: tool({
      description:
        "Calculate 6 critical-speed-anchored running pace zones. Pass the athlete's " +
        "critical speed in m/s (intervals.icu stores threshold_pace in SI m/s, e.g. " +
        "4.0 m/s ≈ 4:10/km). The manual override outranks the platform value; an " +
        "out-of-range lower-boundary override is clamped and the clamp is disclosed. " +
        "Returns zones plus a real confidence/source field — surface the RPE-checked " +
        "estimate framing to the athlete; never present these as lab-measured thresholds.",
      inputSchema: zodSchema(
        z.object({
          criticalSpeedMps: z
            .number()
            .min(CS_SANITY_MPS.min)
            .max(CS_SANITY_MPS.max)
            .describe(
              "Critical speed in m/s (intervals.icu threshold_pace is already m/s). " +
                `Sane band [${CS_SANITY_MPS.min}, ${CS_SANITY_MPS.max}].`,
            ),
          paceUnits: z
            .enum(["MINS_KM", "MINS_MILE"])
            .nullish()
            .describe("Display unit; defaults to min/km when absent."),
          lowerFractionOverride: z
            .number()
            .positive()
            .optional()
            .describe(
              "Manual LT1 (easy↔moderate) boundary as a fraction of CS; outranks the " +
                `flat 0.823. Clamped to [${LOWER_FRACTION_CLAMP.min}, ${LOWER_FRACTION_CLAMP.max}].`,
            ),
          csSource: z
            .enum(["platform", "athlete_manual"])
            .default("platform")
            .describe("Where the CS value came from; 'athlete_manual' = coach/athlete-entered."),
        }),
      ),
      execute: async (input: {
        criticalSpeedMps: number;
        paceUnits?: "MINS_KM" | "MINS_MILE" | null;
        lowerFractionOverride?: number;
        csSource?: "platform" | "athlete_manual";
      }) => {
        const csSource = input.csSource ?? "platform";

        let lowerFraction: number | undefined;
        let clampApplied: { requested: number; clamped: number } | undefined;
        if (input.lowerFractionOverride !== undefined) {
          const { value, clamped } = clampLowerFraction(input.lowerFractionOverride);
          lowerFraction = value;
          if (clamped) clampApplied = { requested: input.lowerFractionOverride, clamped: value };
        }

        const zones: RunningZoneDisplay[] = calculateRunningZones(
          input.criticalSpeedMps,
          input.paceUnits ?? null,
          lowerFraction,
        );

        return {
          zones,
          thresholdDefinition: THRESHOLD_DEFINITION,
          framing: RPE_FRAMING,
          csSource,
          confidence: csSource === "athlete_manual" ? "coach-entered" : "platform-reported",
          ...(clampApplied ? { clampApplied } : {}),
        };
      },
    }),
  };
}
