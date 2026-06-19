import { tool, zodSchema } from "ai";
import { z } from "zod";
import type { MemoryStore, ResolvedCs } from "@enduragent/core";
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
 *
 * The athlete's critical speed is resolved automatically from synced
 * intervals.icu data when available (`resolvedCs` getter, fed per turn by Core);
 * the LLM-supplied `criticalSpeedMps` is now an override, not a requirement.
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
  resolvedCs?: () => ResolvedCs | null,
) {
  return {
    calculate_zones: tool({
      description:
        "Calculate 6 critical-speed-anchored running pace zones. When the athlete's " +
        "critical speed is synced from intervals.icu, OMIT criticalSpeedMps — the tool " +
        "uses the synced anchor automatically and reports its provenance. Pass " +
        "criticalSpeedMps (in m/s; intervals.icu stores threshold_pace in SI m/s, e.g. " +
        "4.0 m/s ≈ 4:10/km) only to override the synced value — a coach-entered number " +
        "or a hypothetical. An explicit value outranks the synced anchor; a manual " +
        "lower-boundary override is clamped and the clamp is disclosed. Returns zones " +
        "plus real source/confidence fields — surface the RPE-checked estimate framing " +
        "to the athlete; never present these as lab-measured thresholds. If no critical " +
        "speed is synced or supplied, the tool returns a no_cs_anchor error — ask the " +
        "athlete for a recent CS / threshold test rather than guessing.",
      inputSchema: zodSchema(
        z.object({
          criticalSpeedMps: z
            .number()
            .min(CS_SANITY_MPS.min)
            .max(CS_SANITY_MPS.max)
            .optional()
            .describe(
              "Override critical speed in m/s (intervals.icu threshold_pace is already m/s). " +
                "Omit to use the synced anchor when one exists. " +
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
            .describe(
              "Provenance of an EXPLICIT criticalSpeedMps; ignored when the synced " +
                "anchor is used (its provenance is reported instead). 'athlete_manual' = " +
                "coach/athlete-entered.",
            ),
        }),
      ),
      execute: async (input: {
        criticalSpeedMps?: number;
        paceUnits?: "MINS_KM" | "MINS_MILE" | null;
        lowerFractionOverride?: number;
        csSource?: "platform" | "athlete_manual";
      }) => {
        const resolved = resolvedCs?.() ?? null;
        // Explicit value (already band-checked by the input schema) outranks the
        // synced anchor (band-checked by resolveRunningCs); whichever we use is
        // therefore guaranteed in [CS_SANITY_MPS.min, max].
        const autoResolved = input.criticalSpeedMps === undefined && resolved !== null;
        const cs = input.criticalSpeedMps ?? resolved?.criticalSpeedMps;
        if (cs === undefined) {
          return {
            error: "no_cs_anchor",
            details:
              "No critical speed is synced from intervals.icu or supplied. Ask the athlete " +
              "for a recent critical-speed / threshold-pace test (or have them set threshold " +
              "pace in intervals.icu), then retry — do not invent a value.",
          };
        }

        let lowerFraction: number | undefined;
        let clampApplied: { requested: number; clamped: number } | undefined;
        if (input.lowerFractionOverride !== undefined) {
          const { value, clamped } = clampLowerFraction(input.lowerFractionOverride);
          lowerFraction = value;
          if (clamped) clampApplied = { requested: input.lowerFractionOverride, clamped: value };
        }

        const zones: RunningZoneDisplay[] = calculateRunningZones(
          cs,
          input.paceUnits ?? null,
          lowerFraction,
        );

        const csSource = autoResolved ? resolved.source : input.csSource ?? "platform";

        return {
          zones,
          criticalSpeedMps: cs,
          thresholdDefinition: THRESHOLD_DEFINITION,
          framing: RPE_FRAMING,
          csSource,
          anchorOrigin: autoResolved ? "auto-resolved" : "supplied",
          confidence: csSource === "athlete_manual" ? "coach-entered" : "platform-reported",
          ...(autoResolved && resolved.confidence ? { platformConfidence: resolved.confidence } : {}),
          ...(clampApplied ? { clampApplied } : {}),
        };
      },
    }),
  };
}
